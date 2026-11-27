import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { db } from "@/db";
import { and, count, desc, eq, getTableColumns, ilike, inArray, sql } from "drizzle-orm";
import { agents, meetings, user } from "@/db/schema";
import { createTRPCRouter, premiumProcedure, protectedProcedure } from "@/trpc/init";
import {
  DEFAULT_PAGE,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  MIN_PAGE_SIZE,
} from "@/constants";
import { meetingsInsertSchema, meetingsUpdateSchema } from "../schemas";
import { MeetingStatus, StreamTranscriptItem } from "../types";
import { streamVideo } from "@/lib/stream-video";
import { generateAvatarUri } from "@/lib/avatar";
import JSONL from "jsonl-parse-stringify";
import { streamChat } from "@/lib/stream-chat";

async function getOwnedAgent(agentId: string, userId: string) {
  const [agent] = await db.select().from(agents).where(and(
    eq(agents.id, agentId),
    eq(agents.userId, userId)
  ));

  if (!agent) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Agent not found" });
  }
  return agent;
}

export const meetingsRouter = createTRPCRouter({
  generateChatToken: protectedProcedure
    .input(z.object({ meetingId: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const userId = ctx.auth.user.id;
      const [meeting] = await db
        .select({ id: meetings.id })
        .from(meetings)
        .where(and(
          eq(meetings.id, input.meetingId),
          eq(meetings.userId, userId),
          eq(meetings.status, "completed")
        ));

      if (!meeting) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Completed meeting not found" });
      }

      await streamChat.upsertUser({ id: userId, role: "user" });
      await streamChat.channel("messaging", meeting.id, {
        created_by_id: userId,
        members: [userId],
      }).create();

      return streamChat.createToken(userId);
    }),
  getTranscript: protectedProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ input, ctx }) => {
      const [existingMeeting] = await db
        .select()
        .from(meetings)
        .where(
          and(eq(meetings.id, input.id), eq(meetings.userId, ctx.auth.user.id))
        );
      if (!existingMeeting) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Meeting not found",
        });
      }

      if (!existingMeeting.transcriptUrl) {
        return [];
      }

      const transcript = await fetch(existingMeeting.transcriptUrl)
        .then((res) => res.text())
        .then((text) => JSONL.parse<StreamTranscriptItem>(text))
        .catch(() => {
          return [];
        });

      const speakerIds = [
        ...new Set(transcript.map((item) => item.speaker_id)),
      ];

      const userSpeakers = await db
        .select()
        .from(user)
        .where(inArray(user.id, speakerIds))
        .then((users) =>
          users.map((user) => ({
            ...user,
            image:
              user.image ??
              generateAvatarUri({
                seed: user.name,
                variant: "initials",
              }),
          }))
        );

      const agentSpeakers = await db
        .select()
        .from(agents)
        .where(inArray(agents.id, speakerIds))
        .then((agents) =>
          agents.map((agent) => ({
            ...agent,
            image: generateAvatarUri({
              seed: agent.name,
              variant: "botttsNeutral",
            }),
          }))
        );

      const speakers = [...userSpeakers, ...agentSpeakers];
      const transcriptWithSpeakers = transcript.map((item) => {
        const speaker = speakers.find(
          (speaker) => speaker.id === item.speaker_id
        );

        if (!speaker) {
          return {
            ...item,
            user: {
              name: "Unknown",
              image: generateAvatarUri({
                seed: "Unknown",
                variant: "initials",
              }),
            },
          };
        }

        return {
          ...item,
          user: {
            name: speaker.name,
            image: speaker.image,
          },
        };
      });

      return transcriptWithSpeakers;
    }),
  generateToken: protectedProcedure
    .input(z.object({ meetingId: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const { id, name, image } = ctx.auth.user;
      const [meeting] = await db
        .select({ id: meetings.id })
        .from(meetings)
        .where(and(
          eq(meetings.id, input.meetingId),
          eq(meetings.userId, id),
          inArray(meetings.status, ["upcoming", "active"])
        ));

      if (!meeting) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Joinable meeting not found" });
      }

      await streamVideo.upsertUsers([{
        id,
        name,
        role: "user",
        image: image ?? generateAvatarUri({ seed: name, variant: "initials" }),
      }]);

      return streamVideo.generateCallToken({
        user_id: id,
        call_cids: [`default:${meeting.id}`],
      });
    }),
  remove: protectedProcedure
      .input(z.object({ id: z.string() }))
      .mutation(async ({ input, ctx }) => {
        const [removedMeeting] = await db
        .delete(meetings)
        .where(
          and(
            eq(meetings.id, input.id),
            eq(meetings.userId, ctx.auth.user.id)
          )
        )
        .returning();
        if (!removedMeeting) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Meeting not found' });
        }
        return removedMeeting;
      }),
  update: protectedProcedure
      .input(meetingsUpdateSchema)
      .mutation(async ({ input, ctx }) => {
        await getOwnedAgent(input.agentId, ctx.auth.user.id);
        const [updatedMeeting] = await db
        .update(meetings)
        .set(input)
        .where(
          and(
            eq(meetings.id, input.id),
            eq(meetings.userId, ctx.auth.user.id)
          )
        )
        .returning();
        if (!updatedMeeting) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Meeting not found' });
        }
        return updatedMeeting;
      }),
    create:premiumProcedure("meetings").input(meetingsInsertSchema).mutation(async({input,ctx})=>{
      const existingAgent = await getOwnedAgent(input.agentId, ctx.auth.user.id);

      await streamVideo.upsertUsers([
        {
          id: existingAgent.id,
          name: existingAgent.name,
          role: "user",
          image: generateAvatarUri({
            seed: existingAgent.name,
            variant: "botttsNeutral",
          }),
        },
      ]);

      const [createdMeeting] = await db.insert(meetings).values({
        ...input,
        userId: ctx.auth.user.id,
      }).returning();

      try {
        const call = streamVideo.video.call("default", createdMeeting.id);
        await call.create({
          data: {
            created_by_id: ctx.auth.user.id,
            members: [{ user_id: ctx.auth.user.id }],
            custom: {
              meetingId: createdMeeting.id,
              meetingName: createdMeeting.name,
            },
            settings_override: {
              transcription: {
                language: "en",
                mode: "auto-on",
                closed_caption_mode: "auto-on",
              },
              recording: { mode: "auto-on", quality: "1080p" },
            },
          },
        });
      } catch (error) {
        await db.delete(meetings).where(eq(meetings.id, createdMeeting.id));
        throw error;
      }

      return createdMeeting;
    }),
  getOne: protectedProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ input, ctx }) => {
      const [existingMeeting] = await db
        .select({
          ...getTableColumns(meetings),
          agent:agents,
          duration: sql<number>`EXTRACT(EPOCH FROM (ended_at - started_at))`.as("duration "),
        })
        .from(meetings)
        .innerJoin(agents, and(eq(meetings.agentId, agents.id), eq(agents.userId, meetings.userId)))
        .where(
          and(eq(meetings.id, input.id), eq(meetings.userId, ctx.auth.user.id))
        );
        if (!existingMeeting) {
            throw new TRPCError({code: 'NOT_FOUND', message: 'Meeting not found'});
        }
      return existingMeeting;
    }),
  getMany: protectedProcedure
    .input(
      z.object({
        page: z.number().int().min(1).default(DEFAULT_PAGE),
        pageSize: z
          .number()
          .int()
          .min(MIN_PAGE_SIZE)
          .max(MAX_PAGE_SIZE)
          .default(DEFAULT_PAGE_SIZE),
        search: z.string().nullish(),
        agentId: z.string().nullish(),
        status: z
        .enum([
          MeetingStatus.Upcoming,
          MeetingStatus.Active,
          MeetingStatus.Completed,
          MeetingStatus.Processing,
          MeetingStatus.Cancelled,
        ])
        .nullish(),
      })
    )
    .query(async ({ ctx, input }) => {
      const { search, page, pageSize, status, agentId } = input;
      const data = await db
        .select({
          ...getTableColumns(meetings),
          agent:agents,
          duration: sql<number>`EXTRACT(EPOCH FROM (ended_at - started_at))`.as("duration "),
        })
        .from(meetings)
        .innerJoin(agents, and(eq(meetings.agentId, agents.id), eq(agents.userId, meetings.userId)))
        .where(
          and(
            eq(meetings.userId, ctx.auth.user.id),
            search ? ilike(meetings.name, `%${search}%`) : undefined,
            status ? eq(meetings.status, status) : undefined,
            agentId ? eq(meetings.agentId, agentId) : undefined,
          )
        )
        .orderBy(desc(meetings.createdAt), desc(meetings.id))
        .limit(pageSize)
        .offset((page - 1) * pageSize);
 
      const [total] = await db
        .select({ count: count() })
        .from(meetings)
        .innerJoin(agents, and(eq(meetings.agentId, agents.id), eq(agents.userId, meetings.userId)))
        .where(
          and(
            eq(meetings.userId, ctx.auth.user.id),
            search ? ilike(meetings.name, `%${search}%`) : undefined,
            status ? eq(meetings.status, status) : undefined,
            agentId ? eq(meetings.agentId, agentId) : undefined,
          )
        );

      const totalPages = Math.ceil(total.count / pageSize);
      return {
        items: data,
        total: total.count,
        totalPages,
      };
    }),
});