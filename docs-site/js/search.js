/**
 * Search functionality
 */

const Search = {
  modal: null,
  input: null,
  results: null,
  isOpen: false,

  /**
   * Initialize search
   */
  init() {
    this.modal = document.getElementById("searchModal");
    this.input = document.getElementById("searchInput");
    this.results = document.getElementById("searchResults");

    this.bindEvents();
    this.buildIndex();
  },

  /**
   * Build search index from commands data
   */
  buildIndex() {
    this.index = [];

    // Index all commands
    for (const [category, data] of Object.entries(COMMANDS_DATA)) {
      for (const cmd of data.commands) {
        this.index.push({
          type: "command",
          category: category,
          categoryTitle: data.title,
          icon: data.icon,
          name: cmd.name,
          desc: cmd.desc,
          usage: cmd.usage,
          example: cmd.example,
          searchText: `${cmd.name} ${cmd.desc} ${data.title}`.toLowerCase(),
        });
      }
    }

    // Index pages
    const pages = [
      { page: "home", title: "Accueil", desc: "Page d'accueil", icon: "🏠" },
      {
        page: "getting-started",
        title: "Démarrage rapide",
        desc: "Comment commencer à utiliser le bot",
        icon: "🚀",
      },
      {
        page: "commands",
        title: "Commandes",
        desc: "Liste de toutes les commandes",
        icon: "📋",
      },
      {
        page: "features",
        title: "Fonctionnalités",
        desc: "Toutes les fonctionnalités du bot",
        icon: "✨",
      },
      {
        page: "developers",
        title: "Développeurs",
        desc: "Guide pour les développeurs",
        icon: "👨‍💻",
      },
      {
        page: "faq",
        title: "FAQ",
        desc: "Questions fréquemment posées",
        icon: "❓",
      },
    ];

    for (const p of pages) {
      this.index.push({
        type: "page",
        page: p.page,
        name: p.title,
        desc: p.desc,
        icon: p.icon,
        searchText: `${p.title} ${p.desc}`.toLowerCase(),
      });
    }
  },

  /**
   * Bind event listeners
   */
  bindEvents() {
    // Open search with button
    document
      .getElementById("searchBtn")
      .addEventListener("click", () => this.open());

    // Keyboard shortcut (Ctrl+K or Cmd+K)
    document.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "k") {
        e.preventDefault();
        this.toggle();
      }
      if (e.key === "Escape" && this.isOpen) {
        this.close();
      }
    });

    // Close on backdrop click
    this.modal.addEventListener("click", (e) => {
      if (e.target === this.modal) {
        this.close();
      }
    });

    // Search input
    this.input.addEventListener(
      "input",
      Utils.debounce((e) => {
        this.search(e.target.value);
      }, 150)
    );

    // Navigate results with keyboard
    this.input.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        this.navigateResults(e.key === "ArrowDown" ? 1 : -1);
      }
      if (e.key === "Enter") {
        this.selectResult();
      }
    });
  },

  /**
   * Open search modal
   */
  open() {
    this.modal.classList.add("active");
    this.isOpen = true;
    this.input.value = "";
    this.input.focus();
    this.showDefaultResults();
    document.body.style.overflow = "hidden";
  },

  /**
   * Close search modal
   */
  close() {
    this.modal.classList.remove("active");
    this.isOpen = false;
    document.body.style.overflow = "";
  },

  /**
   * Toggle search modal
   */
  toggle() {
    if (this.isOpen) {
      this.close();
    } else {
      this.open();
    }
  },

  /**
   * Show default results (popular commands)
   */
  showDefaultResults() {
    const popular = ["ping", "gemini", "sticker", "ytdl", "trt"];
    const results = this.index.filter(
      (item) =>
        item.type === "command" && popular.includes(item.name.split(" ")[0])
    );

    this.renderResults(results, "Commandes populaires");
  },

  /**
   * Perform search
   */
  search(query) {
    if (!query.trim()) {
      this.showDefaultResults();
      return;
    }

    const searchTerms = query.toLowerCase().split(" ");
    const results = this.index.filter((item) => {
      return searchTerms.every((term) => item.searchText.includes(term));
    });

    // Sort by relevance (exact match first)
    results.sort((a, b) => {
      const aExact = a.name.toLowerCase().includes(query.toLowerCase());
      const bExact = b.name.toLowerCase().includes(query.toLowerCase());
      if (aExact && !bExact) return -1;
      if (!aExact && bExact) return 1;
      return 0;
    });

    this.renderResults(
      results.slice(0, 10),
      query ? "Résultats" : "Suggestions"
    );
  },

  /**
   * Render search results
   */
  renderResults(results, title = "") {
    if (results.length === 0) {
      this.results.innerHTML = `
                <div class="search-empty">
                    <p>Aucun résultat trouvé</p>
                    <p style="font-size: var(--text-sm);">Essayez avec d'autres mots-clés</p>
                </div>
            `;
      return;
    }

    let html = "";

    results.forEach((item, index) => {
      html += `
                <div class="search-result-item" data-index="${index}" data-type="${
        item.type
      }" data-value="${item.type === "page" ? item.page : item.category}">
                    <div class="search-result-icon">${item.icon}</div>
                    <div class="search-result-content">
                        <div class="search-result-title">${Utils.escapeHtml(
                          item.name
                        )}</div>
                        <div class="search-result-desc">${Utils.escapeHtml(
                          item.desc
                        )}</div>
                    </div>
                </div>
            `;
    });

    this.results.innerHTML = html;
    this.currentResults = results;
    this.selectedIndex = -1;

    // Add click handlers
    this.results.querySelectorAll(".search-result-item").forEach((item) => {
      item.addEventListener("click", () => {
        const index = parseInt(item.dataset.index);
        this.selectedIndex = index;
        this.selectResult();
      });
    });
  },

  /**
   * Navigate through results
   */
  navigateResults(direction) {
    const items = this.results.querySelectorAll(".search-result-item");
    if (items.length === 0) return;

    // Remove current selection
    items.forEach((item) => item.classList.remove("selected"));

    // Update index
    this.selectedIndex += direction;
    if (this.selectedIndex < 0) this.selectedIndex = items.length - 1;
    if (this.selectedIndex >= items.length) this.selectedIndex = 0;

    // Add selection
    items[this.selectedIndex].classList.add("selected");
    items[this.selectedIndex].scrollIntoView({ block: "nearest" });
  },

  /**
   * Select current result
   */
  selectResult() {
    if (this.selectedIndex < 0 || !this.currentResults) {
      // Select first result if none selected
      const firstItem = this.results.querySelector(".search-result-item");
      if (firstItem) {
        this.selectedIndex = 0;
      } else {
        return;
      }
    }

    const result = this.currentResults[this.selectedIndex];
    this.close();

    if (result.type === "page") {
      Router.navigate(result.page);
    } else if (result.type === "command") {
      Router.navigate("commands");
      // Wait for page to load, then scroll to category
      setTimeout(() => {
        const category = document.getElementById(`category-${result.category}`);
        if (category) {
          category.scrollIntoView({ behavior: "smooth", block: "start" });
        }
      }, 100);
    }
  },
};

// Initialize when DOM is ready
document.addEventListener("DOMContentLoaded", () => {
  Search.init();
});

// Make available globally
window.Search = Search;
