import OpenAI from "openai";
import { and, eq, inArray } from "drizzle-orm";
import { NextResponse, NextRequest } from "next/server";
import {
  CallSessionEndedEvent,
  CallTranscriptionReadyEvent,
  CallRecordingReadyEvent,
  CallSessionParticipantLeftEvent,
  CallSessionStartedEvent,
  MessageNewEvent,
} from "@stream-io/node-sdk";
import { db } from "@/db";
import { agents, meetings } from "@/db/schema";
import { streamVideo } from "@/lib/stream-video";
import { inngest } from "@/inngest/client";
import { streamChat } from "@/lib/stream-chat";
import { ChatCompletionMessageParam } from "openai/resources/index.mjs";
import { generateAvatarUri } from "@/lib/avatar";


// Share concurrent startup attempts within the same server process.
const agentStartups = new Map<string, Promise<string | undefined>>();

async function startMeetingAgent(meetingId: string) {
  const [meeting] = await db
    .select({ status: meetings.status, agentId: meetings.agentId, userId: meetings.userId })
    .from(meetings)
    .where(eq(meetings.id, meetingId));

  if (!meeting) return "Meeting not found";
  if (meeting.status !== "upcoming") return;

  const [agent] = await db
    .select({ instructions: agents.instructions })
    .from(agents)
    .where(and(eq(agents.id, meeting.agentId), eq(agents.userId, meeting.userId)));

  if (!agent) return "Agent not found";

  const realtimeClient = await streamVideo.video.connectOpenAi({
    call: streamVideo.video.call("default", meetingId),
    openAiApiKey: process.env.OPENAI_API_KEY!,
    agentUserId: meeting.agentId,
    model: "gpt-realtime",
  });

  try {
    realtimeClient.updateSession({ instructions: agent.instructions });
    const [activatedMeeting] = await db
      .update(meetings)
      .set({ status: "active", startedAt: new Date() })
      .where(and(eq(meetings.id, meetingId), eq(meetings.status, "upcoming")))
      .returning({ id: meetings.id });

    if (!activatedMeeting) realtimeClient.disconnect();
  } catch (error) {
    realtimeClient.disconnect();
    throw error;
  }
}

export async function POST(req: NextRequest) {
  const signature = req.headers.get("x-signature");
  const apiKey = req.headers.get("x-api-key");
  if (!signature || !apiKey) {
    return NextResponse.json(
      { error: "Missing signature or API key" },
      { status: 400 }
    );
  }
  const body = await req.text();
  let payload: unknown;
  try {
    payload = JSON.parse(body) as Record<string, unknown>;
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON payload" },
      { status: 400 }
    );
  }
  const eventType = (payload as Record<string, unknown>)?.type;
  const isChatEvent = apiKey === process.env.NEXT_PUBLIC_STREAM_CHAT_API_KEY &&
    (typeof eventType !== "string" || !eventType.startsWith("call."));
  const isVideoEvent = apiKey === process.env.NEXT_PUBLIC_STREAM_VIDEO_API_KEY &&
    eventType !== "message.new";
  if (
    !(isChatEvent && streamChat.verifyWebhook(body, signature)) &&
    !(isVideoEvent && streamVideo.verifyWebhook(body, signature))
  ) {
    return NextResponse.json({ error: "Invalid signature or API key" }, { status: 401 });
  }
  if (eventType === "call.session_started") {
    const event = payload as CallSessionStartedEvent;
    const meetingId = event.call.custom?.meetingId;
    if (!meetingId) {
      return NextResponse.json(
        { error: "Missing meetingId in call session started event" },
        { status: 400 }
      );
    }
    let startup = agentStartups.get(meetingId);
    if (!startup) {
      startup = startMeetingAgent(meetingId).finally(() => {
        agentStartups.delete(meetingId);
      });
      agentStartups.set(meetingId, startup);
    }

    try {
      const error = await startup;
      if (error) {
        return NextResponse.json({ error }, { status: 404 });
      }
    } catch (error) {
      console.error("Failed to start meeting agent", { meetingId, error });
      return NextResponse.json(
        { error: "Failed to start meeting agent" },
        { status: 503 }
      );
    }
  } else if (eventType === "call.session_participant_left") {
    const event = payload as CallSessionParticipantLeftEvent;
    const meetingId = event.call_cid.split(":")[1]; //call_cid is formatted as "type:id"

    if (!meetingId) {
      return NextResponse.json(
        { error: "Missing meetingId" },
        { status: 400 }
      );
    }
    const [meeting] = await db
      .select({ userId: meetings.userId })
      .from(meetings)
      .where(eq(meetings.id, meetingId));

    if (!meeting || event.participant.user.id !== meeting.userId) {
      return NextResponse.json({ status: "ok" });
    }

    const call = streamVideo.video.call("default", meetingId);
    await call.end();
  } else if (eventType === "call.session_ended") {
    const event = payload as CallSessionEndedEvent;
    const meetingId = event.call.custom?.meetingId;
    if (!meetingId) {
      return NextResponse.json(
        { error: "Missing meetingId" },
        { status: 400 }
      );
    }
    await db
    .update(meetings)
    .set({
      status: "processing",
      endedAt: new Date(),
    })
      .where(
        and(
          eq(meetings.id, meetingId),
          inArray(meetings.status, ["upcoming", "active"])
        )
      );
  } else if (eventType === "call.transcription_ready") {
    const event = payload as CallTranscriptionReadyEvent;
    const meetingId = event.call_cid.split(":")[1]; //call_cid is formatted as "type:id"
    const [updatedMeeting] = await db
      .update(meetings)
      .set({
        transcriptUrl: event.call_transcription.url,
      })
      .where(eq(meetings.id, meetingId))
      .returning();
    if (!updatedMeeting) {
      return NextResponse.json(
        { error: "Meeting not found" },
        { status: 404 }
      );
    }
    await inngest.send({
      id: req.headers.get("x-webhook-id") ?? undefined,
      name: "meetings/processing",
      data: {
        meetingId: updatedMeeting.id,
        transcriptUrl: updatedMeeting.transcriptUrl,
      }
    })
  } else if (eventType === "call.recording_ready") {
    const event = payload as CallRecordingReadyEvent;
    const meetingId = event.call_cid.split(":")[1]; //call_cid is formatted as "type:id"
    await db
    .update(meetings)
    .set({
      recordingUrl: event.call_recording.url,
    })
    .where(eq(meetings.id, meetingId));
  } else if (eventType === "message.new") {
    const event = payload as MessageNewEvent;
    const userId = event.user?.id;
    const channelId = event.channel_id;
    const text = event.message?.text;
    if (!userId || !channelId || !text) {
      return NextResponse.json(
        { error: "Missing required fields" },
        { status: 400 }
      );
    }

    const [existingMeeting] = await db
      .select()
      .from(meetings)
      .where(and(
        eq(meetings.id, channelId),
        eq(meetings.status, "completed"),
        eq(meetings.userId, userId)
      ));

    if (!existingMeeting || event.channel_type !== "messaging") {
      return NextResponse.json({ status: "ok" });
    }

    const [existingAgent] = await db
      .select()
      .from(agents)
      .where(and(eq(agents.id, existingMeeting.agentId), eq(agents.userId, userId)));

    if (!existingAgent) {
      return NextResponse.json({ error: "Agent not found" }, { status: 404 });
    }

    const instructions = `
You are an AI assistant helping the user revisit a recently completed meeting.
Answer using the meeting summary and recent conversation. If the summary has insufficient information, say so.
Follow the original agent instructions below and keep responses concise.

Meeting summary:
${existingMeeting.summary}

Original agent instructions:
${existingAgent.instructions}
    `.trim();

    const channel = streamChat.channel("messaging", channelId);
    const { messages } = await channel.query({ messages: { limit: 6 } });
    const history = messages
      .filter((message) =>
        message.id !== event.message?.id &&
        (message.user?.id === userId || message.user?.id === existingAgent.id) &&
        message.text?.trim()
      )
      .slice(-5)
      .map<ChatCompletionMessageParam>((message) => ({
        role: message.user?.id === existingAgent.id ? "assistant" : "user",
        content: message.text ?? "",
      }));

    const openai = new OpenAI();
    const response = await openai.chat.completions.create({
      messages: [
        { role: "system", content: instructions },
        ...history,
        { role: "user", content: text },
      ],
      model: "gpt-4o",
    });

    const reply = response.choices[0]?.message.content?.trim();
    if (!reply) {
      return NextResponse.json({ error: "No response from AI" }, { status: 502 });
    }

    await streamChat.upsertUser({
      id: existingAgent.id,
      name: existingAgent.name,
      image: generateAvatarUri({ seed: existingAgent.name, variant: "botttsNeutral" }),
    });

    await channel.sendMessage({ text: reply, user_id: existingAgent.id });
  }

  return NextResponse.json({ status: "ok" });
}
