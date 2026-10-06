// Minimal single-page app: history-API routing and views rendered after a slow fetch.
const root = document.querySelector("#app");

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

function navigate(path) {
  history.pushState({}, "", path);
  route();
}

async function showList() {
  const response = await fetch("/spa/api/jobs");
  const { jobs } = await response.json();
  if (location.pathname.startsWith("/spa/jobs/")) return;
  const list = el("ul", { className: "jobs" });
  list.setAttribute("aria-label", "Open positions");
  for (const job of jobs) {
    const link = el("a", {
      className: "title",
      href: `/spa/jobs/${job.id}`,
      textContent: job.title,
    });
    link.addEventListener("click", (event) => {
      event.preventDefault();
      navigate(link.getAttribute("href"));
    });
    const meta = el(
      "p",
      { className: "meta" },
      el("span", { className: "loc", textContent: job.location }),
      " · ",
      el("span", { className: "type", textContent: job.employmentType }),
    );
    const item = el("li", { className: "job" }, link, meta);
    item.dataset.jobId = job.id;
    list.append(item);
  }
  root.replaceChildren(el("h1", { textContent: "Open positions" }), list);
}

async function showDetail(id) {
  const response = await fetch(`/spa/api/jobs/${id}`);
  if (location.pathname !== `/spa/jobs/${id}`) return;
  if (!response.ok) {
    root.replaceChildren(el("h1", { textContent: "Job not found" }));
    return;
  }
  const job = await response.json();
  const back = el("a", { href: "/spa/", textContent: "Back to all jobs" });
  back.addEventListener("click", (event) => {
    event.preventDefault();
    navigate("/spa/");
  });
  const facts = el(
    "dl",
    { className: "facts" },
    el("dt", { textContent: "Location" }),
    el("dd", { className: "loc", textContent: job.location }),
    el("dt", { textContent: "Salary" }),
    el("dd", { className: "salary", textContent: job.salary }),
  );
  root.replaceChildren(
    el("h1", { className: "job-title", textContent: job.title }),
    facts,
    el("article", { className: "job-body" }, el("p", { textContent: job.description })),
    el("p", {}, back),
  );
}

function route() {
  root.replaceChildren(el("p", { className: "loading", textContent: "Loading…" }));
  const match = location.pathname.match(/^\/spa\/jobs\/([^/]+)$/);
  if (match) showDetail(match[1]);
  else showList();
}

window.addEventListener("popstate", route);
route();
