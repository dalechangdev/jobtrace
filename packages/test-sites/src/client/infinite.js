// Infinite-scroll job list: loads a batch whenever the sentinel scrolls into view.
const list = document.querySelector("#jobs");
const sentinel = document.querySelector("#sentinel");
const batchSize = Number(list.dataset.batchSize);
let offset = 0;
let loading = false;
let done = false;

function render(job) {
  const item = document.createElement("li");
  item.className = "job";
  item.dataset.jobId = job.id;
  const title = document.createElement("a");
  title.className = "title";
  title.href = `/detail/jobs/${job.id}`;
  title.textContent = job.title;
  const meta = document.createElement("p");
  meta.className = "meta";
  const loc = document.createElement("span");
  loc.className = "loc";
  loc.textContent = job.location;
  const type = document.createElement("span");
  type.className = "type";
  type.textContent = job.employmentType;
  meta.append(loc, " · ", type);
  item.append(title, meta);
  return item;
}

async function loadMore() {
  if (loading || done) return;
  loading = true;
  const response = await fetch(`/infinite/api/jobs?offset=${offset}&limit=${batchSize}`);
  const { jobs, total } = await response.json();
  list.append(...jobs.map(render));
  offset += jobs.length;
  done = offset >= total;
  if (done) {
    sentinel.textContent = "No more jobs";
    observer.disconnect();
  }
  loading = false;
  // The sentinel may still be on screen after a short batch; keep filling.
  if (!done && sentinel.getBoundingClientRect().top < window.innerHeight) loadMore();
}

const observer = new IntersectionObserver((entries) => {
  if (entries.some((entry) => entry.isIntersecting)) loadMore();
});
observer.observe(sentinel);
