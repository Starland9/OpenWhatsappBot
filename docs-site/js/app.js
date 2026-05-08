/**
 * Main Application - Initialize everything
 */

document.addEventListener("DOMContentLoaded", () => {
  // Initialize theme
  initTheme();

  // Initialize header scroll effect
  initHeaderScroll();

  // Initialize mobile menu
  initMobileMenu();

  // Initialize router
  Router.init();
});

/**
 * Theme management
 */
function initTheme() {
  const themeToggle = document.getElementById("themeToggle");
  const savedTheme = Utils.storage.get("theme", "light");

  // Apply saved theme
  document.documentElement.setAttribute("data-theme", savedTheme);

  // Toggle theme on click
  themeToggle.addEventListener("click", () => {
    const currentTheme = document.documentElement.getAttribute("data-theme");
    const newTheme = currentTheme === "dark" ? "light" : "dark";

    document.documentElement.setAttribute("data-theme", newTheme);
    Utils.storage.set("theme", newTheme);
  });

  // Listen for system theme changes
  window
    .matchMedia("(prefers-color-scheme: dark)")
    .addEventListener("change", (e) => {
      if (!Utils.storage.get("theme")) {
        document.documentElement.setAttribute(
          "data-theme",
          e.matches ? "dark" : "light"
        );
      }
    });
}

/**
 * Header scroll effect
 */
function initHeaderScroll() {
  const header = document.getElementById("header");

  const handleScroll = Utils.throttle(() => {
    if (window.scrollY > 10) {
      header.classList.add("scrolled");
    } else {
      header.classList.remove("scrolled");
    }
  }, 100);

  window.addEventListener("scroll", handleScroll);
}

/**
 * Mobile menu toggle
 */
function initMobileMenu() {
  const mobileMenuBtn = document.getElementById("mobileMenuBtn");
  const nav = document.getElementById("nav");

  mobileMenuBtn.addEventListener("click", () => {
    mobileMenuBtn.classList.toggle("active");
    nav.classList.toggle("active");

    // Prevent body scroll when menu is open
    if (nav.classList.contains("active")) {
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
    }
  });

  // Close menu when clicking a link
  nav.querySelectorAll(".nav-link").forEach((link) => {
    link.addEventListener("click", () => {
      mobileMenuBtn.classList.remove("active");
      nav.classList.remove("active");
      document.body.style.overflow = "";
    });
  });
}

/**
 * Smooth scroll for anchor links
 */
document.addEventListener("click", (e) => {
  const anchor = e.target.closest('a[href^="#"]');
  if (anchor && anchor.getAttribute("href").length > 1) {
    const targetId = anchor.getAttribute("href").slice(1);
    const targetElement = document.getElementById(targetId);

    if (targetElement) {
      e.preventDefault();
      Utils.scrollToElement(targetId, 80);
    }
  }
});

/**
 * Keyboard shortcuts
 */
document.addEventListener("keydown", (e) => {
  // Focus search with /
  if (e.key === "/" && !e.ctrlKey && !e.metaKey) {
    const activeElement = document.activeElement;
    if (
      activeElement.tagName !== "INPUT" &&
      activeElement.tagName !== "TEXTAREA"
    ) {
      e.preventDefault();
      Search.open();
    }
  }
});

// Service Worker for offline support (optional)
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    // navigator.serviceWorker.register('/sw.js')
    //     .then(reg => console.log('SW registered'))
    //     .catch(err => console.log('SW registration failed'));
  });
}
