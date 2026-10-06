import { randomBytes } from "node:crypto";

export const ID_PREFIXES = {
  recording: "rec",
  recordingVersion: "rcv",
  run: "run",
  job: "job",
  authProfile: "auth",
  schedule: "sch",
  artifact: "art",
  event: "evt",
} as const;

export type IdKind = keyof typeof ID_PREFIXES;

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** A ULID: 48-bit millisecond timestamp plus 80 random bits, lexicographically sortable. */
export function ulid(now: number = Date.now()): string {
  let time = "";
  let remaining = now;
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD.charAt(remaining % 32) + time;
    remaining = Math.floor(remaining / 32);
  }
  let random = "";
  for (const byte of randomBytes(16)) random += CROCKFORD.charAt(byte % 32);
  return time + random;
}

/** Prefixed id such as `rec_01J...`. */
export function newId(kind: IdKind, now?: number): string {
  return `${ID_PREFIXES[kind]}_${ulid(now)}`;
}
