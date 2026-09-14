/** Full-screen menu and the nav that pins itself (solid, light) once the dark header scrolls away. */
export function initChrome(): void {
  const menu = document.getElementById("menu");
  const nav = document.getElementById("nav");
  const open = () => {
    if (!menu) return;
    menu.classList.add("open");
    document.body.classList.add("menu-open");
    menu.querySelector<HTMLElement>("[data-menu-close]")?.focus();
  };
  const close = () => {
    if (!menu) return;
    menu.classList.remove("open");
    document.body.classList.remove("menu-open");
    document.querySelector<HTMLElement>("[data-menu-open]")?.focus();
  };
  document.querySelectorAll("[data-menu-open]").forEach((b) => b.addEventListener("click", open));
  document.querySelectorAll("[data-menu-close]").forEach((b) => b.addEventListener("click", close));
  menu?.querySelectorAll("a").forEach((a) => a.addEventListener("click", close));
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });

  if (!nav) return;
  const dark = document.querySelector<HTMLElement>(".hero, .page-head");
  if (!dark) return;
  const update = () => {
    const pinned = window.scrollY > dark.offsetHeight - 70;
    nav.classList.toggle("stuck", pinned);
    nav.classList.toggle("solid", pinned);
  };
  window.addEventListener("scroll", update, { passive: true });
  update();
}
