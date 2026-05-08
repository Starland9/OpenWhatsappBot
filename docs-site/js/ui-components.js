/**
 * Reusable UI Components
 */

const Components = {
  /**
   * Feature card for home page
   */
  featureCard(icon, title, description) {
    return `
            <div class="feature-card">
                <div class="icon">${icon}</div>
                <h3>${title}</h3>
                <p>${description}</p>
            </div>
        `;
  },

  /**
   * Profile card for "Who is this for" section
   */
  profileCard(profile) {
    return `
            <div class="profile-card">
                <div class="profile-header">
                    <span class="profile-icon">${profile.icon}</span>
                    <div>
                        <div class="profile-title">${profile.title}</div>
                        <div class="profile-subtitle">${profile.subtitle}</div>
                    </div>
                </div>
                <p style="font-size: var(--text-sm); color: var(--text-secondary); margin-bottom: var(--space-4);">${
                  profile.description
                }</p>
                <div class="profile-commands">
                    ${profile.commands
                      .map(
                        (cmd) => `<span class="profile-command">${cmd}</span>`
                      )
                      .join("")}
                </div>
            </div>
        `;
  },

  /**
   * Step component for guides
   */
  step(number, title, description) {
    return `
            <div class="step">
                <div class="step-number">${number}</div>
                <div class="step-content">
                    <h3 class="step-title">${title}</h3>
                    <p class="step-desc">${description}</p>
                </div>
            </div>
        `;
  },

  /**
   * Command card with expandable details
   */
  commandCard(cmd) {
    return `
            <div class="command-card">
                <div class="command-header">
                    <span class="command-name">.${cmd.name}</span>
                    <span class="command-desc">${cmd.desc}</span>
                    <svg class="command-expand" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M6 9l6 6 6-6"></path>
                    </svg>
                </div>
                <div class="command-details">
                    <div class="command-details-inner">
                        <div class="command-example">
                            <div class="command-example-title">Utilisation</div>
                            <div class="command-box">
                                <span class="prefix">$</span>
                                <code>${cmd.usage}</code>
                                <button class="copy-btn" data-copy="${cmd.usage}" title="Copier">
                                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                        <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                                        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                                    </svg>
                                </button>
                            </div>
                        </div>
                        <div class="command-example">
                            <div class="command-example-title">Exemple</div>
                            <div class="command-box">
                                <span class="prefix">$</span>
                                <code>${cmd.example}</code>
                                <button class="copy-btn" data-copy="${cmd.example}" title="Copier">
                                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                        <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                                        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                                    </svg>
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        `;
  },

  /**
   * Quick command display
   */
  commandQuick(command, description) {
    return `
            <div class="card" style="padding: var(--space-4);">
                <div class="command-box" style="margin-bottom: var(--space-2);">
                    <code>${command}</code>
                </div>
                <p style="font-size: var(--text-sm); color: var(--text-secondary); margin: 0;">${description}</p>
            </div>
        `;
  },

  /**
   * Code block with syntax highlighting placeholder
   */
  codeBlock(language, code) {
    return `
            <div class="code-block">
                <div class="code-block-header">
                    <span class="code-block-lang">${language}</span>
                    <button class="code-block-copy">Copier</button>
                </div>
                <pre><code>${Utils.escapeHtml(code)}</code></pre>
            </div>
        `;
  },

  /**
   * Feature list item with checkmark
   */
  featureItem(text) {
    return `
            <div class="feature-item">
                <span class="feature-icon">✓</span>
                <span class="feature-text">${text}</span>
            </div>
        `;
  },

  /**
   * Alert/Notice box
   */
  alert(type, title, message) {
    const icons = {
      info: "💡",
      success: "✅",
      warning: "⚠️",
      error: "❌",
    };
    return `
            <div class="alert alert-${type}">
                <span class="alert-icon">${icons[type]}</span>
                <div class="alert-content">
                    <div class="alert-title">${title}</div>
                    <p style="margin: 0;">${message}</p>
                </div>
            </div>
        `;
  },

  /**
   * Badge component
   */
  badge(text, type = "") {
    return `<span class="badge ${type ? "badge-" + type : ""}">${text}</span>`;
  },
};

// Make available globally
window.Components = Components;
