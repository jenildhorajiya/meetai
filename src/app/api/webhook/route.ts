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


const openaiClient = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY!,
});

function verifySignatureWithSDK(body: string, signature: string): boolean {
  return streamVideo.verifyWebhook(body, signature);
}

// Share concurrent startup attempts within the same server process.
const agentStartups = new Map<string, Promise<string | undefined>>();

async function startMeetingAgent(meetingId: string) {
  const [meeting] = await db
    .select({ status: meetings.status, agentId: meetings.agentId })
    .from(meetings)
    .where(eq(meetings.id, meetingId));

  if (!meeting) return "Meeting not found";
  if (meeting.status !== "upcoming") return;

  const [agent] = await db
    .select({ instructions: agents.instructions })
    .from(agents)
    .where(eq(agents.id, meeting.agentId));

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
  if (!verifySignatureWithSDK(body, signature)) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }
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
      .select({ agentId: meetings.agentId })
      .from(meetings)
      .where(eq(meetings.id, meetingId));

    if (!meeting || event.participant.user.id === meeting.agentId) {
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
      .where(and(eq(meetings.id, channelId), eq(meetings.status, "completed")));
      if (!existingMeeting) {
        return NextResponse.json(
          { error: "Meeting not found" },
          { status: 404 }
        );
      }
      const [existingAgent] = await db
      .select()
      .from(agents)
      .where(eq(agents.id, existingMeeting.agentId));

      if (!existingAgent) {
        return NextResponse.json(
          { error: "Agent not found" },
          { status: 404 }
        );
      }

      if (userId !== existingAgent.id) {
        const instructions = `
      You are an AI assistant helping the user revisit a recently completed meeting.
      Below is a summary of the meeting, generated from the transcript:
      
      ${existingMeeting.summary}
      
      The following are your original instructions from the live meeting assistant. Please continue to follow these behavioral guidelines as you assist the user:
      
      ${existingAgent.instructions}
      
      The user may ask questions about the meeting, request clarifications, or ask for follow-up actions.
      Always base your responses on the meeting summary above.
      
      You also have access to the recent conversation history between you and the user. Use the context of previous messages to provide relevant, coherent, and helpful responses. If the user's question refers to something discussed earlier, make sure to take that into account and maintain continuity in the conversation.
      
      If the summary does not contain enough information to answer a question, politely let the user know.
      
      Be concise, helpful, and focus on providing accurate information from the meeting and the ongoing conversation.
      `;

      const channel = streamChat.channel("messaging", channelId);
      await channel.watch();
      const previousMessages = channel.state.messages
        .slice(-5)
        .filter((msg) => msg.text && msg.text.trim() !== "")
        .map<ChatCompletionMessageParam>((message) => ({
          role: message.user?.id === existingAgent.id ? "assistant" : "user",
          content: message.text || "",
        }))

        const GPTResponse = await openaiClient.chat.completions.create({
          messages: [
            { role: "system", content: instructions},
            ...previousMessages,
            { role: "user", content: text }
          ],
          model: "gpt-4o",
        })

        const GPTResponseText = GPTResponse.choices[0].message.content;
        if (!GPTResponseText) {
          return NextResponse.json(
            { error: "No response from AI" },
            { status: 400 }
          );
        }

        const avatarUrl = generateAvatarUri({
          seed: existingAgent.name,
          variant: "botttsNeutral",
        })

        streamChat.upsertUser({
          id: existingAgent.id,
          name: existingAgent.name,
          image: avatarUrl
        })

        channel.sendMessage({
          text: GPTResponseText,
          user: {
            id: existingAgent.id,
            name: existingAgent.name,
            image: avatarUrl
          }
        })

      }
  }
  
  return NextResponse.json({ status: "ok" });
} 