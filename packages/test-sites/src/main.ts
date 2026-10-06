import { SITES, startTestSites } from "./server.ts";

const port = Number(process.env.TEST_SITES_PORT ?? 4400);
// 127.0.0.1 unless told otherwise; a container must listen on 0.0.0.0 to be reachable from outside it.
const sites = await startTestSites(port, process.env.TEST_SITES_HOST ?? "127.0.0.1");
console.log(`JobTrace test sites listening on ${sites.origin}`);
for (const [name, path] of Object.entries(SITES)) {
  console.log(`  ${name.padEnd(18)} ${sites.url(path)}`);
}
