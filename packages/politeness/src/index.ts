import type { RobotsPolicy } from "@jobtrace/core";
import { DomainLocks } from "./locks.ts";
import { createRobots, type RobotsOptions } from "./robots.ts";

export {
  type BotWallRules,
  type BotWallVerdict,
  DEFAULT_BOT_WALL_RULES,
  detectBotWall,
} from "./botwall.ts";
export { DomainLocks } from "./locks.ts";
export { retryAfterMs } from "./retry.ts";
export { createRobots, ROBOTS_USER_AGENT, type RobotsOptions } from "./robots.ts";

/** The shared politeness state of one process: robots.txt knowledge and per-domain turns. */
export interface Politeness {
  robots: RobotsPolicy;
  locks: DomainLocks;
}

export function createPoliteness(options: RobotsOptions = {}): Politeness {
  return { robots: createRobots(options), locks: new DomainLocks() };
}
