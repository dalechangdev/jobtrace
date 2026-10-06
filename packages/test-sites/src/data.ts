/**
 * Ground-truth job data behind every fixture site. Tests compare extracted jobs
 * against this module, so it is the single source of truth for the mock sites.
 */
export interface FixtureJob {
  id: string;
  title: string;
  location: string;
  employmentType: string;
  salary: string;
  /** ISO date (YYYY-MM-DD). */
  postedAt: string;
  description: string;
}

export const COMPANY = "Acme Robotics";

const TITLES = [
  "Senior Backend Engineer",
  "Frontend Engineer",
  "Staff Platform Engineer",
  "Data Engineer",
  "Machine Learning Engineer",
  "Site Reliability Engineer",
  "Engineering Manager, Payments",
  "Product Designer",
  "Security Engineer",
  "QA Automation Engineer",
  "Mobile Engineer (iOS)",
  "Mobile Engineer (Android)",
  "Developer Advocate",
  "Technical Writer",
  "Solutions Architect",
  "Embedded Software Engineer",
  "Robotics Perception Engineer",
  "Controls Engineer",
  "Firmware Engineer",
  "Technical Program Manager",
] as const;

const LOCATIONS = [
  "Berlin, Germany",
  "Remote (EU)",
  "Madrid, Spain",
  "New York, NY",
  "Hybrid - London, UK",
];
const TYPES = ["Full-time", "Full-time", "Contract", "Part-time"];
const SALARIES = [
  "€85,000 - €110,000 per year",
  "$140k - $180k / year",
  "£70,000 - £90,000 per year",
  "$65 - $80 per hour",
  "€95,000 per year",
];

function pick<T>(list: readonly T[], index: number): T {
  return list[index % list.length] as T;
}

export const ALL_JOBS: readonly FixtureJob[] = TITLES.map((title, index) => {
  const day = String(1 + ((index * 3) % 28)).padStart(2, "0");
  const location = pick(LOCATIONS, index);
  return {
    id: String(101 + index),
    title,
    location,
    employmentType: pick(TYPES, index),
    salary: pick(SALARIES, index),
    postedAt: `2026-09-${day}`,
    description:
      `${COMPANY} is hiring a ${title} based in ${location}. ` +
      `You will own projects end to end and work closely with a small, senior team. ` +
      `Requirement ${index + 1}: several years of relevant experience.`,
  };
});

/** Number of jobs each fixture site serves, in `ALL_JOBS` order. */
export const SITE_JOB_COUNTS = {
  staticList: 8,
  paginated: 12,
  infinite: 20,
  detail: 8,
  spa: 6,
  login: 5,
  iframe: 7,
} as const;

export const PAGINATED_PAGE_SIZE = 5;
export const INFINITE_BATCH_SIZE = 6;
/** Artificial latency of the SPA's JSON API, to exercise delayed rendering. */
export const SPA_API_DELAY_MS = 300;

export function jobsFor(site: keyof typeof SITE_JOB_COUNTS): FixtureJob[] {
  return ALL_JOBS.slice(0, SITE_JOB_COUNTS[site]);
}

export function findJob(id: string): FixtureJob | undefined {
  return ALL_JOBS.find((job) => job.id === id);
}
