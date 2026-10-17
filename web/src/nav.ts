/** Shared site header for the v2 pages. */
const LINKS: [string, string][] = [
  ["/", "Overview"],
  ["/how.html", "How it works"],
  ["/bench.html", "Benchmarks & limits"],
  ["/apps.html", "Dynamic apps"],
  ["/rooms.html", "AI rooms"],
  ["/cursors.html?backend=pool", "Cursors"],
  ["/editor.html?backend=pool", "Editor"],
];

export function mountNav() {
  const here = location.pathname === "/index.html" ? "/" : location.pathname;
  const header = document.createElement("header");
  header.className = "site";
  header.innerHTML =
    `<a class="brand" href="/">do<span>-pool</span></a><nav>` +
    LINKS.map(([href, label]) => `<a href="${href}" class="${href.split("?")[0] === here ? "on" : ""}">${label}</a>`).join("") +
    `</nav>`;
  document.body.prepend(header);
  document.body.classList.add("v2");
}
