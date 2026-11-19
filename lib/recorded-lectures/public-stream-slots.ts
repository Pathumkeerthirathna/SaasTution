import { StreamSlots } from "./stream-slots";

/*
 * Concurrent stream limits for PUBLIC playback of recorded lectures (public
 * class pages, anonymous visitors). A separate, smaller pool on top of the
 * process-wide pool in stream-slots.ts: a public stream takes one slot here
 * AND one in the shared pool, so anonymous traffic can never use more than
 * MAX_PUBLIC_STREAMS_PER_PROCESS of the shared slots that enrolled students
 * also need.
 *
 *   per client   MAX_PUBLIC_STREAMS_PER_CLIENT   -> 429 STREAM_LIMIT_REACHED
 *   per process  MAX_PUBLIC_STREAMS_PER_PROCESS  -> 503 STREAMING_BUSY
 *
 * "Client" is the address our trusted proxy saw (lib/error-logging/
 * request-trust.ts clientKey). Without a trusted proxy there is no reliable
 * client identity: each request is then its own client and only the
 * per-process limit applies. Same in-memory, single-process model as
 * stream-slots.ts (production runs one Next.js process).
 */

export const MAX_PUBLIC_STREAMS_PER_CLIENT = 4;
export const MAX_PUBLIC_STREAMS_PER_PROCESS = 16;

const slotState = globalThis as unknown as { slRecordedLecturePublicStreamSlots?: StreamSlots };

/** This process's public playback stream slots. */
export function getPublicStreamSlots(): StreamSlots {
  if (!slotState.slRecordedLecturePublicStreamSlots) {
    slotState.slRecordedLecturePublicStreamSlots = new StreamSlots(MAX_PUBLIC_STREAMS_PER_CLIENT, MAX_PUBLIC_STREAMS_PER_PROCESS);
  }
  return slotState.slRecordedLecturePublicStreamSlots;
}

/** Tests: start from empty public slots (optionally with other limits). */
export function resetPublicStreamSlotsForTests(perClient?: number, perProcess?: number): StreamSlots {
  slotState.slRecordedLecturePublicStreamSlots = new StreamSlots(perClient ?? MAX_PUBLIC_STREAMS_PER_CLIENT, perProcess ?? MAX_PUBLIC_STREAMS_PER_PROCESS);
  return slotState.slRecordedLecturePublicStreamSlots;
}
