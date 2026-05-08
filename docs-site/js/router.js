/**
 * Router - Client-side navigation
 */

const Router = {
  currentPage: "home",

  /**
   * Initialize router
   */
  init() {
    this.bindEvents();

    // Handle initial page load
    const hash = window.location.hash.slice(1) || "home";
    this.navigate(hash, false);

    // Handle browser back/forward
    window.addEventListener("popstate", () => {
      const hash = window.location.hash.slice(1) || "home";
      this.navigate(hash, false);
    });
  },

  /**
   * Bind navigation events
   */
  bindEvents() {
    document.addEventListener("click", (e) => {
      const link = e.target.closest("[data-page]");
      if (link) {
        e.preventDefault();
        const page = link.dataset.page;
        this.navigate(page);
      }
    });
  },

  /**
   * Navigate to a page
   */
  navigate(page, updateHistory = true) {
    // Update URL
    if (updateHistory) {
      window.history.pushState({}, "", `#${page}`);
    }

    // Update navigation active state
    document.querySelectorAll(".nav-link").forEach((link) => {
      link.classList.toggle("active", link.dataset.page === page);
    });

    // Close mobile menu if open
    document.getElementById("nav").classList.remove("active");
    document.getElementById("mobileMenuBtn").classList.remove("active");

    // Load page content
    this.loadPage(page);

    // Scroll to top
    window.scrollTo({ top: 0, behavior: "smooth" });

    this.currentPage = page;
  },

  /**
   * Load page content
   */
  loadPage(page) {
    const main = document.getElementById("main");

    // Add loading state
    main.style.opacity = "0.5";

    // Get page content
    const content = Pages[page] ? Pages[page]() : Pages.notFound();

    // Update content with animation
    setTimeout(() => {
      main.innerHTML = content;
      main.style.opacity = "1";

      // Initialize page-specific functionality
      this.initPageFeatures(page);
    }, 150);
  },

  /**
   * Initialize page-specific features
   */
  initPageFeatures(page) {
    // Initialize accordions
    document.querySelectorAll(".accordion-header").forEach((header) => {
      header.addEventListener("click", () => {
        const item = header.closest(".accordion-item");
        item.classList.toggle("open");
      });
    });

    // Initialize command cards
    document.querySelectorAll(".command-header").forEach((header) => {
      header.addEventListener("click", () => {
        const card = header.closest(".command-card");
        card.classList.toggle("open");
      });
    });

    // Initialize copy buttons
    document.querySelectorAll(".copy-btn, .code-block-copy").forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const text =
          btn.dataset.copy ||
          btn.closest(".command-box, .code-block")?.querySelector("code")
            ?.textContent;
        if (text) {
          const success = await Utils.copyToClipboard(text);
          if (success) {
            btn.classList.add("copied");
            const originalText = btn.textContent;
            btn.textContent = "Copié !";
            setTimeout(() => {
              btn.classList.remove("copied");
              btn.textContent = originalText;
            }, 2000);
          }
        }
      });
    });

    // Initialize tabs
    document.querySelectorAll(".tab").forEach((tab) => {
      tab.addEventListener("click", () => {
        const tabGroup = tab.closest(".tabs");
        const targetId = tab.dataset.tab;

        // Update active tab
        tabGroup
          .querySelectorAll(".tab")
          .forEach((t) => t.classList.remove("active"));
        tab.classList.add("active");

        // Show target content
        const container = tabGroup.nextElementSibling;
        if (container) {
          container.querySelectorAll(".tab-content").forEach((content) => {
            content.style.display = content.id === targetId ? "block" : "none";
          });
        }
      });
    });

    // Initialize command category navigation
    document.querySelectorAll(".commands-nav-link").forEach((link) => {
      link.addEventListener("click", (e) => {
        e.preventDefault();
        const category = link.dataset.category;
        const element = document.getElementById(`category-${category}`);
        if (element) {
          element.scrollIntoView({ behavior: "smooth", block: "start" });
        }

        // Update active state
        document
          .querySelectorAll(".commands-nav-link")
          .forEach((l) => l.classList.remove("active"));
        link.classList.add("active");
      });
    });
  },
};

// Make available globally
window.Router = Router;
