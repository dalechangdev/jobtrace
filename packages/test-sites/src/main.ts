import { SITES, startTestSites } from "./server.ts";

const port = Number(process.env.TEST_SITES_PORT ?? 4400);
const sites = await startTestSites(port);
console.log(`JobTrace test sites listening on ${sites.origin}`);
for (const [name, path] of Object.entries(SITES)) {
  console.log(`  ${name.padEnd(18)} ${sites.url(path)}`);
}
