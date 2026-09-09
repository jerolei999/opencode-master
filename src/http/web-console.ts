/**
 * OpenCode Master Cloud Web Console
 * Multi-tenant, full-featured web interface served directly by Master.
 * Supports multi-user login/switch, sessions CRUD, streaming chat with markdown & thinking,
 * tool cards, question reply, worker cluster status, and scheduled task badges.
 */
export function webAppHtml(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>OpenCode Cloud · 多租户智能研发工作台</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
  <style>
    :root {
      color-scheme: dark;
      --bg: #090d16;
      --surface-1: #0f1626;
      --surface-2: #162035;
      --surface-3: #1f2d4a;
      --border: #263654;
      --border-subtle: #1c2942;
      --text: #e6edf8;
      --text-muted: #8fa0c0;
      --text-dim: #5c6f93;
      --primary: #6366f1;
      --primary-hover: #4f46e5;
      --primary-glow: rgba(99, 102, 241, 0.25);
      --accent: #8b5cf6;
      --success: #10b981;
      --warning: #f59e0b;
      --danger: #ef4444;
      --schedule-badge: #ec4899;
      --radius-sm: 6px;
      --radius-md: 10px;
      --radius-lg: 16px;
      --shadow-sm: 0 2px 8px rgba(0, 0, 0, 0.2);
      --shadow-md: 0 8px 24px rgba(0, 0, 0, 0.35);
      --shadow-lg: 0 20px 50px rgba(0, 0, 0, 0.5);
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: radial-gradient(1200px 800px at 100% -150px, #1e294b 0%, transparent 65%), var(--bg);
      color: var(--text);
      font-family: 'Inter', system-ui, -apple-system, sans-serif;
      font-size: 14px;
      line-height: 1.5;
      height: 100vh;
      overflow: hidden;
    }

    .main{min-width:0;min-height:0;}.message-scroller{min-height:0;overflow:auto;overscroll-behavior:contain}.session-list{min-height:0;flex:1}

    /* Layout Shell */
    .app-shell {
      display: grid;
      grid-template-columns: 290px minmax(0, 1fr) 280px;
      height: 100vh;
      width: 100vw;
      overflow: hidden;
    }

    /* Sidebar */
    .sidebar {
      background: var(--surface-1);
      border-right: 1px solid var(--border);
      display: flex;
      flex-direction: column;
      min-width: 0;
      z-index: 10;
    }

    .brand-header {
      padding: 16px 18px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      border-bottom: 1px solid var(--border-subtle);
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 10px;
      font-weight: 750;
      font-size: 16px;
      letter-spacing: -0.02em;
    }
    .brand-logo {
      width: 30px;
      height: 30px;
      border-radius: 9px;
      background: linear-gradient(135deg, var(--primary), var(--accent));
      display: flex;
      align-items: center;
      justify-content: center;
      color: #fff;
      font-weight: 800;
      box-shadow: 0 4px 14px var(--primary-glow);
    }
    .brand-tag {
      font-size: 10px;
      padding: 2px 6px;
      border-radius: 4px;
      background: rgba(99, 102, 241, 0.15);
      color: #a5b4fc;
      border: 1px solid rgba(99, 102, 241, 0.3);
      text-transform: uppercase;
      font-weight: 700;
    }

    .sidebar-actions {
      padding: 14px 16px 8px;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .btn-new-session {
      width: 100%;
      padding: 10px 14px;
      border-radius: var(--radius-md);
      background: linear-gradient(135deg, var(--primary), #4f46e5);
      color: #fff;
      border: 0;
      font-weight: 600;
      font-size: 13.5px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      transition: all 0.15s ease;
      box-shadow: 0 4px 16px var(--primary-glow);
    }
    .btn-new-session:hover {
      filter: brightness(1.1);
      transform: translateY(-1px);
    }
    .search-box {
      position: relative;
    }
    .search-input {
      width: 100%;
      padding: 8px 12px 8px 32px;
      border-radius: var(--radius-sm);
      background: var(--surface-2);
      border: 1px solid var(--border-subtle);
      color: var(--text);
      font-size: 12.5px;
      outline: none;
    }
    .search-input:focus {
      border-color: var(--primary);
    }
    .search-icon {
      position: absolute;
      left: 10px;
      top: 50%;
      transform: translateY(-50%);
      font-size: 13px;
      color: var(--text-dim);
      pointer-events: none;
    }

    .session-section-title {
      padding: 10px 18px 4px;
      font-size: 11px;
      font-weight: 700;
      color: var(--text-dim);
      text-transform: uppercase;
      letter-spacing: 0.08em;
      display: flex;
      justify-content: space-between;
    }

    .session-list {
      flex: 1;
      overflow-y: auto;
      padding: 6px 10px 16px;
      list-style: none;
      display: flex;
      flex-direction: column;
      gap: 3px;
    }
    .session-item {
      position: relative;
      border-radius: var(--radius-md);
      padding: 9px 12px;
      cursor: pointer;
      transition: all 0.12s ease;
      display: flex;
      flex-direction: column;
      gap: 4px;
      border: 1px solid transparent;
      user-select: none;
    }
    .session-item:hover {
      background: rgba(255, 255, 255, 0.04);
    }
    .session-item.active {
      background: var(--surface-2);
      border-color: var(--border);
      box-shadow: var(--shadow-sm);
    }
    .session-title-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 6px;
    }
    .session-title {
      font-weight: 550;
      font-size: 13px;
      color: var(--text);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      flex: 1;
    }
    .session-meta-row {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 11px;
      color: var(--text-muted);
    }
    .status-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: var(--text-dim);
    }
    .status-dot.ok, .status-dot.assigned { background: var(--success); }
    .status-dot.running { background: var(--primary); animation: pulse 1.5s infinite; }
    .status-dot.recovering, .status-dot.waiting_input { background: var(--warning); }
    .status-dot.ended { background: var(--text-dim); }

    .schedule-badge {
      font-size: 9.5px;
      padding: 1px 5px;
      border-radius: 4px;
      background: rgba(236, 72, 153, 0.15);
      color: #f472b6;
      border: 1px solid rgba(236, 72, 153, 0.3);
      font-weight: 600;
    }

    .session-actions {
      display: none;
      align-items: center;
      gap: 4px;
      position: absolute;
      right: 8px;
      top: 50%;
      transform: translateY(-50%);
      background: var(--surface-2);
      padding: 2px 4px;
      border-radius: var(--radius-sm);
    }
    .session-item:hover .session-actions {
      display: flex;
    }
    .action-icon-btn {
      border: 0;
      background: transparent;
      color: var(--text-muted);
      cursor: pointer;
      padding: 3px 5px;
      border-radius: 4px;
      font-size: 12px;
    }
    .action-icon-btn:hover {
      color: var(--text);
      background: var(--surface-3);
    }
    .action-icon-btn.danger:hover {
      color: var(--danger);
      background: rgba(239, 68, 68, 0.15);
    }

    /* Sidebar Footer (User Account) */
    .sidebar-footer {
      padding: 12px 14px;
      border-top: 1px solid var(--border-subtle);
      background: rgba(15, 22, 38, 0.95);
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
    }
    .user-profile {
      display: flex;
      align-items: center;
      gap: 10px;
      min-width: 0;
      flex: 1;
    }
    .avatar-circle {
      width: 32px;
      height: 32px;
      border-radius: 50%;
      background: linear-gradient(135deg, #3b82f6, #8b5cf6);
      color: #fff;
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: 700;
      font-size: 13px;
      flex-shrink: 0;
    }
    .user-info {
      min-width: 0;
      flex: 1;
    }
    .user-name-display {
      font-size: 13px;
      font-weight: 650;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .user-role-badge {
      font-size: 11px;
      color: var(--text-muted);
      display: flex;
      align-items: center;
      gap: 5px;
    }
    .btn-logout {
      border: 0;
      background: transparent;
      color: var(--text-muted);
      cursor: pointer;
      padding: 6px;
      border-radius: var(--radius-sm);
      font-size: 14px;
      transition: all 0.15s;
    }
    .btn-logout:hover {
      color: var(--danger);
      background: rgba(239, 68, 68, 0.12);
    }

    /* Main Chat Center */
    .main {
      display: flex;
      flex-direction: column;
      min-width: 0;
      height: 100vh;
      background: var(--bg);
      position: relative;
    }

    .chat-header {
      height: 64px;
      padding: 0 24px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      border-bottom: 1px solid var(--border-subtle);
      background: rgba(9, 13, 22, 0.85);
      backdrop-filter: blur(12px);
      z-index: 5;
    }
    .chat-title-info {
      min-width: 0;
      flex: 1;
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .chat-active-title {
      font-size: 15px;
      font-weight: 700;
      color: var(--text);
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .chat-active-title-text {
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .chat-subtitle {
      font-size: 11.5px;
      color: var(--text-muted);
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .header-controls {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .connection-pill {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 4px 9px;
      border-radius: 20px;
      background: var(--surface-2);
      border: 1px solid var(--border-subtle);
      font-size: 11.5px;
      color: var(--text-muted);
    }
    .btn-stop {
      padding: 6px 12px;
      border-radius: var(--radius-sm);
      background: rgba(239, 68, 68, 0.15);
      color: #f87171;
      border: 1px solid rgba(239, 68, 68, 0.3);
      font-size: 12.5px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.15s;
    }
    .btn-stop:hover:not(:disabled) {
      background: var(--danger);
      color: #fff;
    }
    .btn-stop:disabled {
      opacity: 0.4;
      cursor: not-allowed;
    }

    /* Message Scroller */
    .message-scroller {
      flex: 1;
      overflow-y: auto;
      padding: 24px clamp(20px, 5vw, 64px) 20px;
      display: flex;
      flex-direction: column;
      gap: 20px;
      scroll-behavior: smooth;
    }
    .messages-container {
      max-width: 860px;
      width: 100%;
      margin: 0 auto;
      display: flex;
      flex-direction: column;
      gap: 20px;
    }

    /* Welcome Banner */
    .welcome-card {
      margin: 40px auto;
      max-width: 620px;
      text-align: center;
      padding: 36px 24px;
      background: var(--surface-1);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-lg);
      box-shadow: var(--shadow-md);
    }
    .welcome-logo {
      width: 52px;
      height: 52px;
      border-radius: 16px;
      background: linear-gradient(135deg, var(--primary), var(--accent));
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-size: 24px;
      font-weight: 800;
      color: #fff;
      margin-bottom: 18px;
      box-shadow: 0 8px 24px var(--primary-glow);
    }
    .welcome-card h1 {
      font-size: 22px;
      font-weight: 750;
      margin-bottom: 8px;
      letter-spacing: -0.02em;
    }
    .welcome-card p {
      color: var(--text-muted);
      font-size: 13.5px;
      line-height: 1.6;
      margin-bottom: 24px;
    }
    .prompt-suggestions {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px;
      text-align: left;
    }
    .suggestion-btn {
      padding: 12px 14px;
      border-radius: var(--radius-md);
      background: var(--surface-2);
      border: 1px solid var(--border-subtle);
      color: var(--text);
      font-size: 12.5px;
      cursor: pointer;
      transition: all 0.15s;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .suggestion-btn:hover {
      border-color: var(--primary);
      background: var(--surface-3);
      transform: translateY(-1px);
    }
    .suggestion-title {
      font-weight: 600;
      color: #c7d2fe;
    }
    .suggestion-desc {
      color: var(--text-muted);
      font-size: 11px;
    }

    /* Message Bubbles */
    .message-row {
      display: flex;
      gap: 14px;
      align-items: flex-start;
    }
    .message-row.user {
      flex-direction: row-reverse;
    }
    .message-avatar {
      width: 32px;
      height: 32px;
      border-radius: 10px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: 700;
      font-size: 13px;
      flex-shrink: 0;
    }
    .message-row.assistant .message-avatar {
      background: linear-gradient(135deg, var(--primary), var(--accent));
      color: #fff;
    }
    .message-row.user .message-avatar {
      background: #3b82f6;
      color: #fff;
    }
    .message-body {
      max-width: min(780px, calc(100% - 46px));
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .message-header-label {
      font-size: 11.5px;
      color: var(--text-dim);
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .message-row.user .message-header-label {
      justify-content: flex-end;
    }

    .bubble {
      padding: 14px 18px;
      border-radius: var(--radius-lg);
      font-size: 14px;
      line-height: 1.6;
      border: 1px solid var(--border);
      background: var(--surface-1);
      box-shadow: var(--shadow-sm);
      overflow-wrap: break-word;
    }
    .message-row.user .bubble {
      background: #23355a;
      border-color: #3b507d;
      color: #f1f5f9;
      border-top-right-radius: var(--radius-sm);
    }
    .message-row.assistant .bubble {
      border-top-left-radius: var(--radius-sm);
    }

    /* Thinking (Reasoning) Panel */
    .thinking-panel {
      margin-bottom: 8px;
      border-radius: var(--radius-md);
      background: rgba(10, 15, 28, 0.7);
      border: 1px solid var(--border-subtle);
      overflow: hidden;
    }
    .thinking-header {
      padding: 8px 12px;
      font-size: 12px;
      font-weight: 600;
      color: #a5b4fc;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 6px;
      user-select: none;
    }
    .thinking-content {
      padding: 10px 14px;
      font-family: 'JetBrains Mono', monospace;
      font-size: 12px;
      color: #94a3b8;
      line-height: 1.6;
      border-top: 1px solid var(--border-subtle);
      white-space: pre-wrap;
      max-height: 260px;
      overflow-y: auto;
    }

    /* Markdown Styling */
    .bubble h1, .bubble h2, .bubble h3, .bubble h4 {
      margin: 14px 0 6px;
      color: #fff;
      font-weight: 700;
    }
    .bubble h1 { font-size: 18px; }
    .bubble h2 { font-size: 16px; }
    .bubble h3 { font-size: 14.5px; }
    .bubble p { margin-bottom: 8px; }
    .bubble p:last-child { margin-bottom: 0; }
    .bubble ul, .bubble ol {
      margin: 6px 0 10px 22px;
    }
    .bubble li { margin-bottom: 4px; }
    .bubble code {
      font-family: 'JetBrains Mono', monospace;
      font-size: 12.5px;
      background: rgba(255, 255, 255, 0.08);
      padding: 2px 5px;
      border-radius: 4px;
      color: #cbd5e1;
    }
    .code-block-wrapper {
      margin: 10px 0;
      border-radius: var(--radius-md);
      overflow: hidden;
      border: 1px solid var(--border);
      background: #0b111e;
    }
    .code-block-header {
      padding: 6px 12px;
      background: var(--surface-2);
      border-bottom: 1px solid var(--border-subtle);
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-size: 11.5px;
      color: var(--text-muted);
      font-family: 'JetBrains Mono', monospace;
    }
    .btn-copy-code {
      border: 0;
      background: transparent;
      color: var(--text-muted);
      cursor: pointer;
      font-size: 11px;
      padding: 2px 6px;
      border-radius: 4px;
    }
    .btn-copy-code:hover {
      background: var(--surface-3);
      color: var(--text);
    }
    .code-block-wrapper pre {
      padding: 12px 14px;
      overflow-x: auto;
      font-family: 'JetBrains Mono', monospace;
      font-size: 12.5px;
      line-height: 1.55;
      color: #e2e8f0;
      margin: 0;
    }

    /* Tool & Question Cards */
    .tool-card {
      margin: 8px 0;
      border-radius: var(--radius-md);
      border: 1px solid var(--border);
      background: var(--surface-2);
      overflow: hidden;
    }
    .tool-header {
      padding: 8px 12px;
      background: var(--surface-3);
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 12px;
      font-weight: 650;
      color: #93c5fd;
    }
    .tool-content {
      padding: 10px 12px;
      font-family: 'JetBrains Mono', monospace;
      font-size: 12px;
      color: #cbd5e1;
      white-space: pre-wrap;
      max-height: 200px;
      overflow-y: auto;
    }

    .question-card {
      margin: 10px 0;
      border-radius: var(--radius-md);
      border: 1px solid #4338ca;
      background: #131b33;
      padding: 16px;
      box-shadow: 0 4px 20px rgba(99, 102, 241, 0.15);
    }
    .question-title {
      font-size: 14px;
      font-weight: 700;
      color: #e0e7ff;
      margin-bottom: 12px;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .question-options-group {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 10px;
    }
    .question-btn {
      padding: 8px 14px;
      border-radius: var(--radius-sm);
      background: var(--surface-2);
      border: 1px solid var(--border);
      color: var(--text);
      font-size: 12.5px;
      cursor: pointer;
      transition: all 0.15s;
    }
    .question-btn:hover, .question-btn.selected {
      border-color: var(--primary);
      background: #2d3b66;
    }
    .btn-submit-answer {
      margin-top: 12px;
      padding: 7px 14px;
      border-radius: var(--radius-sm);
      background: var(--primary);
      color: #fff;
      border: 0;
      font-weight: 600;
      cursor: pointer;
    }
    .btn-submit-answer:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    /* Composer Area */
    .composer-wrapper {
      padding: 12px clamp(20px, 5vw, 64px) 20px;
      background: linear-gradient(transparent, var(--bg) 35%);
    }
    .composer-card {
      max-width: 860px;
      margin: 0 auto;
      border-radius: var(--radius-lg);
      background: var(--surface-1);
      border: 1px solid var(--border);
      box-shadow: var(--shadow-md);
      padding: 12px 16px 10px;
      transition: border-color 0.15s, box-shadow 0.15s;
    }
    .composer-card:focus-within {
      border-color: var(--primary);
      box-shadow: 0 0 0 3px var(--primary-glow), var(--shadow-md);
    }
    #composer {
      width: 100%;
      min-height: 48px;
      max-height: 180px;
      background: transparent;
      border: 0;
      outline: 0;
      color: var(--text);
      font-family: inherit;
      font-size: 14px;
      line-height: 1.55;
      resize: none;
    }
    .composer-footer {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-top: 6px;
      padding-top: 6px;
      border-top: 1px solid var(--border-subtle);
    }
    .composer-hints {
      font-size: 11.5px;
      color: var(--text-dim);
    }
    .btn-send {
      padding: 8px 16px;
      border-radius: var(--radius-sm);
      background: var(--primary);
      color: #fff;
      border: 0;
      font-weight: 600;
      font-size: 13px;
      cursor: pointer;
      transition: all 0.15s;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .btn-send:hover:not(:disabled) {
      background: var(--primary-hover);
      transform: translateY(-1px);
    }
    .btn-send:disabled {
      opacity: 0.45;
      cursor: not-allowed;
    }

    /* Inspector Panel */
    .inspector {
      background: var(--surface-1);
      border-left: 1px solid var(--border);
      display: flex;
      flex-direction: column;
      overflow-y: auto;
      padding: 18px 16px;
      gap: 20px;
    }
    .inspector-title {
      font-size: 11px;
      font-weight: 750;
      color: var(--text-dim);
      text-transform: uppercase;
      letter-spacing: 0.08em;
      margin-bottom: 8px;
    }
    .info-card {
      padding: 12px 14px;
      border-radius: var(--radius-md);
      background: var(--surface-2);
      border: 1px solid var(--border-subtle);
      display: flex;
      flex-direction: column;
      gap: 8px;
      font-size: 12px;
    }
    .info-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 8px;
    }
    .info-label { color: var(--text-muted); }
    .info-value {
      color: var(--text);
      font-weight: 600;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 140px;
    }
    .worker-card-item {
      padding: 10px 12px;
      border-radius: var(--radius-sm);
      background: var(--surface-2);
      border: 1px solid var(--border-subtle);
      margin-bottom: 6px;
      display: flex;
      flex-direction: column;
      gap: 3px;
    }
    .worker-name {
      font-weight: 650;
      font-size: 12.5px;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .worker-load-meta {
      font-size: 11px;
      color: var(--text-muted);
    }

    /* Modal dialogs */
    .modal-backdrop {
      position: fixed;
      inset: 0;
      background: rgba(5, 8, 16, 0.82);
      backdrop-filter: blur(8px);
      z-index: 50;
      display: none;
      place-items: center;
      padding: 20px;
    }
    .modal-backdrop.open { display: grid; }
    .modal-card {
      width: min(450px, 100%);
      background: var(--surface-1);
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      box-shadow: var(--shadow-lg);
      padding: 24px;
      display: flex;
      flex-direction: column;
      gap: 16px;
    }
    .modal-header h2 {
      font-size: 18px;
      font-weight: 750;
      letter-spacing: -0.01em;
    }
    .modal-header p {
      color: var(--text-muted);
      font-size: 12.5px;
      margin-top: 4px;
    }
    .form-field {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .form-field label {
      font-size: 12px;
      font-weight: 600;
      color: var(--text-muted);
    }
    .form-input {
      width: 100%;
      padding: 9px 12px;
      border-radius: var(--radius-sm);
      background: var(--surface-2);
      border: 1px solid var(--border);
      color: var(--text);
      font-size: 13.5px;
      outline: none;
    }
    .form-input:focus { border-color: var(--primary); }
    .quick-users-row {
      display: flex;
      gap: 6px;
      margin-top: 4px;
    }
    .quick-user-chip {
      padding: 4px 9px;
      border-radius: var(--radius-sm);
      background: var(--surface-2);
      border: 1px solid var(--border-subtle);
      color: #93c5fd;
      font-size: 11.5px;
      cursor: pointer;
    }
    .quick-user-chip:hover {
      background: var(--surface-3);
      border-color: var(--primary);
    }
    .modal-actions {
      display: flex;
      justify-content: flex-end;
      gap: 10px;
      margin-top: 8px;
    }
    .btn-secondary {
      padding: 8px 14px;
      border-radius: var(--radius-sm);
      background: var(--surface-2);
      border: 1px solid var(--border);
      color: var(--text);
      cursor: pointer;
    }
    .btn-primary {
      padding: 8px 16px;
      border-radius: var(--radius-sm);
      background: var(--primary);
      border: 0;
      color: #fff;
      font-weight: 600;
      cursor: pointer;
    }

    /* Toasts */
    .toast-tray {
      position: fixed;
      bottom: 24px;
      right: 24px;
      display: flex;
      flex-direction: column;
      gap: 8px;
      z-index: 100;
    }
    .toast-item {
      padding: 11px 16px;
      border-radius: var(--radius-md);
      background: var(--surface-2);
      border: 1px solid var(--border);
      color: var(--text);
      box-shadow: var(--shadow-md);
      font-size: 13px;
      display: flex;
      align-items: center;
      gap: 8px;
      animation: slideIn 0.2s ease;
    }
    .toast-item.error {
      border-color: rgba(239, 68, 68, 0.4);
      background: #281219;
      color: #fca5a5;
    }
    .toast-item.success {
      border-color: rgba(16, 185, 129, 0.4);
      background: #0f2720;
      color: #6ee7b7;
    }

    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.4; }
    }
    @keyframes slideIn {
      from { transform: translateY(10px); opacity: 0; }
      to { transform: translateY(0); opacity: 1; }
    }

    @media (max-width: 1080px) {
      .app-shell { grid-template-columns: 270px 1fr; }
      .inspector { display: none; }
    }
    @media (max-width: 720px) {
      .app-shell { grid-template-columns: 1fr; }
      .sidebar { display: none; }
    }
  </style>
</head>
<body>

<div class="app-shell">
  <!-- Left Sidebar -->
  <aside class="sidebar">
    <div class="brand-header">
      <div class="brand">
        <div class="brand-logo">O</div>
        <span>OpenCode</span>
      </div>
      <span class="brand-tag" id="cloudTag">Cloud</span>
    </div>

    <div class="sidebar-actions">
      <button class="btn-new-session" id="newSession">
        <span>＋</span> 新建会话
      </button>
      <div class="search-box">
        <span class="search-icon">🔍</span>
        <input class="search-input" id="sessionSearch" placeholder="搜索会话..." autocomplete="off">
      </div>
    </div>

    <div class="session-section-title">
      <span>会话列表</span>
      <span id="sessionCount">0</span>
    </div>

    <ul class="session-list" id="sessionList">
      <!-- Session items will be dynamically injected here -->
    </ul>

    <div class="sidebar-footer">
      <div class="user-profile">
        <div class="avatar-circle" id="userAvatar">A</div>
        <div class="user-info">
          <div class="user-name-display" id="userName">未连接</div>
          <div class="user-role-badge">
            <span id="userTenant">default</span> · <span id="userRole">user</span>
          </div>
        </div>
      </div>
      <button class="btn-logout" id="btnLogout" title="切换账号 / 退出登录">↪</button>
    </div>
  </aside>

  <!-- Center Main Chat Area -->
  <main class="main">
    <header class="chat-header">
      <div class="chat-title-info">
        <div class="chat-active-title">
          <span class="chat-active-title-text" id="chatTitle">选择或创建一个会话</span>
        </div>
        <div class="chat-subtitle">
          <span id="chatSessionId">ID: —</span>
          <span>·</span>
          <span id="chatWorkerId">节点: —</span>
        </div>
      </div>
      <div class="header-controls">
        <div class="connection-pill" id="connectionState">
          <span class="status-dot"></span>
          <span id="connText">就绪</span>
        </div>
        <button class="btn-stop" id="btnStop" disabled>停止</button>
      </div>
    </header>

    <div class="message-scroller" id="messageScroller">
      <div class="messages-container" id="messagesContainer">
        <div class="welcome-card" id="welcomeCard">
          <div class="welcome-logo">✦</div>
          <h1>开始专注的 AI 智能体协作</h1>
          <p>当前运行在企业多租户主从架构下。支持真正的工具调用、代码重构以及由 DolphinScheduler 调度的自动化定时任务。</p>
          <div class="prompt-suggestions">
            <button class="suggestion-btn" data-prompt="帮我设置每天早上9点查询最新科技早报并整理归档">
              <span class="suggestion-title">⏰ 设定每日科技早报</span>
              <span class="suggestion-desc">通过 DolphinScheduler 创建定时 Agent 任务</span>
            </button>
            <button class="suggestion-btn" data-prompt="请分析当前工作区目录结构，并列出关键模块的功能">
              <span class="suggestion-title">📂 分析工作区结构</span>
              <span class="suggestion-desc">调用文件系统与代码分析工具</span>
            </button>
            <button class="suggestion-btn" data-prompt="帮我用 TypeScript 写一个高效的 LRU 缓存类并附带测试用例">
              <span class="suggestion-title">⚡ 编写算法与测试</span>
              <span class="suggestion-desc">直接生成并执行代码校验</span>
            </button>
            <button class="suggestion-btn" data-prompt="列出当前所有已注册的定时调度任务">
              <span class="suggestion-title">📋 查询当前定时调度</span>
              <span class="suggestion-desc">检查属于你名下的所有定时流水线</span>
            </button>
          </div>
        </div>
      </div>
    </div>

    <div class="composer-wrapper">
      <div class="composer-card">
        <textarea id="composer" placeholder="描述你想完成的目标，按 Enter 发送..." disabled></textarea>
        <div class="composer-footer">
          <span class="composer-hints">Enter 发送 · Shift + Enter 换行</span>
          <button class="btn-send" id="sendButton" disabled>
            <span>发送</span> ↵
          </button>
        </div>
      </div>
    </div>
  </main>

  <!-- Right Inspector Panel -->
  <aside class="inspector">
    <div>
      <div class="inspector-title">当前会话信息</div>
      <div class="info-card">
        <div class="info-row">
          <span class="info-label">会话 ID</span>
          <span class="info-value" id="insSessionId">—</span>
        </div>
        <div class="info-row">
          <span class="info-label">所属用户</span>
          <span class="info-value" id="insUserId">—</span>
        </div>
        <div class="info-row">
          <span class="info-label">执行 Worker</span>
          <span class="info-value" id="insWorker">—</span>
        </div>
        <div class="info-row">
          <span class="info-label">状态</span>
          <span class="info-value" id="insStatus">—</span>
        </div>
      </div>
    </div>

    <div>
      <div class="inspector-title">集群执行节点 (Workers)</div>
      <div id="workerListContainer">
        <span style="color:var(--text-dim);font-size:12px">正在拉取节点...</span>
      </div>
    </div>

    <div>
      <div class="inspector-title">调度中枢联动</div>
      <div class="info-card">
        <div class="info-row">
          <span class="info-label">调度引擎</span>
          <span class="info-value">DolphinScheduler</span>
        </div>
        <div class="info-row">
          <span class="info-label">触发回调</span>
          <span class="info-value">/api/v1/schedules/trigger</span>
        </div>
        <div class="info-row">
          <span class="info-label">用户隔离</span>
          <span class="info-value" style="color:var(--success)">Project Prefix 启用</span>
        </div>
      </div>
    </div>
  </aside>
</div>

<!-- Login Modal -->
<div class="modal-backdrop" id="loginModal">
  <div class="modal-card">
    <div class="modal-header">
      <h2>登录 OpenCode Cloud 工作台</h2>
      <p>支持多租户与多用户隔离，每个用户拥有独立的会话、工作区与定时任务</p>
    </div>

    <div class="form-field">
      <label>快速体验账号（点击一键填入）：</label>
      <div class="quick-users-row">
        <span class="quick-user-chip" data-user="alice" data-tenant="default">Alice (研发)</span>
        <span class="quick-user-chip" data-user="bob" data-tenant="default">Bob (全栈)</span>
        <span class="quick-user-chip" data-user="admin" data-tenant="default">Admin (管理员)</span>
      </div>
    </div>

    <form id="loginForm" style="display:flex;flex-direction:column;gap:12px;">
      <div class="form-field">
        <label>用户标识 (User ID)</label>
        <input class="form-input" id="loginUser" value="alice" required autocomplete="username">
      </div>
      <div class="form-field">
        <label>所属租户 (Tenant ID)</label>
        <input class="form-input" id="loginTenant" value="default" required>
      </div>
      <div class="form-field">
        <label>系统密钥 (API Key / Token)</label>
        <input class="form-input" id="loginApiKey" value="dev-admin-key" type="password" required autocomplete="current-password">
      </div>
      <div class="modal-actions">
        <button type="submit" class="btn-primary" style="width:100%">进入工作台</button>
      </div>
    </form>
  </div>
</div>

<!-- Rename Modal -->
<div class="modal-backdrop" id="renameModal">
  <div class="modal-card">
    <div class="modal-header">
      <h2>重命名会话</h2>
      <p>为你的会话设置一个清晰的名字</p>
    </div>
    <form id="renameForm" style="display:flex;flex-direction:column;gap:12px;">
      <input type="hidden" id="renameSessionId">
      <div class="form-field">
        <label>新标题</label>
        <input class="form-input" id="renameTitleInput" required autocomplete="off">
      </div>
      <div class="modal-actions">
        <button type="button" class="btn-secondary" id="btnCancelRename">取消</button>
        <button type="submit" class="btn-primary">保存修改</button>
      </div>
    </form>
  </div>
</div>

<!-- Toast notifications -->
<div class="toast-tray" id="toastRegion"></div>

<script>
  // State
  var token = localStorage.getItem("oc_token") || null;
  var currentUser = localStorage.getItem("oc_user") || "alice";
  var currentTenant = localStorage.getItem("oc_tenant") || "default";
  var sessions = [];
  var currentSessionId = null;
  var eventSourceController = null;
  var isSending = false;

  var $ = function(id) { return document.getElementById(id); };

  // Toast
  function toast(msg, kind) {
    kind = kind || "";
    var t = document.createElement("div");
    t.className = "toast-item " + kind;
    t.innerHTML = (kind === "error" ? "❌ " : kind === "success" ? "✅ " : "ℹ️ ") + escapeHtml(msg);
    $("toastRegion").appendChild(t);
    setTimeout(function() { t.remove(); }, 4000);
  }

  function escapeHtml(str) {
    return String(str == null ? "" : str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // Simple Markdown to HTML Formatter
  function renderMarkdown(raw) {
    if (!raw) return "";
    var s = escapeHtml(raw);

    var bt = String.fromCharCode(96);
    var tripleBt = bt + bt + bt;

    // Code blocks
    var codeBlocks = s.split(tripleBt);
    if (codeBlocks.length > 1) {
      var result = "";
      for (var i = 0; i < codeBlocks.length; i++) {
        if (i % 2 === 1) {
          var lines = codeBlocks[i].split("\\n");
          var lang = (lines[0] || "").trim() || "text";
          var code = lines.slice(1).join("\\n");
          result += '<div class="code-block-wrapper"><div class="code-block-header"><span>' + lang + '</span><button class="btn-copy-code" onclick="copyCode(this)">复制</button></div><pre><code>' + code + '</code></pre></div>';
        } else {
          result += codeBlocks[i];
        }
      }
      s = result;
    }

    // Inline code
    var inlineParts = s.split(bt);
    if (inlineParts.length > 1) {
      var res = "";
      for (var j = 0; j < inlineParts.length; j++) {
        res += (j % 2 === 1) ? ("<code>" + inlineParts[j] + "</code>") : inlineParts[j];
      }
      s = res;
    }

    // Headers
    s = s.replace(/^### (.*$)/gm, "<h3>$1</h3>");
    s = s.replace(/^## (.*$)/gm, "<h2>$1</h2>");
    s = s.replace(/^# (.*$)/gm, "<h1>$1</h1>");

    // Bold & italic
    s = s.replace(/\\*\\*([^\\*]+)\\*\\*/g, "<strong>$1</strong>");
    s = s.replace(/\\*([^\\*]+)\\*/g, "<em>$1</em>");

    // Bullet points
    s = s.replace(/^\\s*[-*+]\\s+(.*$)/gm, "<ul><li>$1</li></ul>");
    s = s.replace(/<\\/ul>\\s*<ul>/g, "");

    // Newlines
    s = s.replace(/\\n/g, "<br>");
    return s;
  }

  window.copyCode = function(btn) {
    var code = btn.closest(".code-block-wrapper").querySelector("code").textContent;
    navigator.clipboard.writeText(code).then(function() {
      btn.textContent = "已复制!";
      setTimeout(function() { btn.textContent = "复制"; }, 2000);
    });
  };

  function renderTool(data) {
    appendToolCard(data.name || "tool", data.content || "");
  }

  function setConnectionState(dotClass, text) {
    var el = $("connectionState");
    if (el) {
      var dot = el.querySelector(".status-dot");
      if (dot) dot.className = "status-dot " + dotClass;
      var txt = $("connText");
      if (txt) txt.textContent = text;
    }
  }

  // API helper
  async function api(method, path, body) {
    if (!token) throw new Error("未登录");
    var headers = {
      authorization: "Bearer " + token
    };
    if (body !== undefined) headers["content-type"] = "application/json";
    var res = await fetch(path, {
      method: method,
      headers: headers,
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
    if (!res.ok) {
      var err = res.statusText;
      try {
        var j = await res.json();
        err = j.error?.message || j.message || err;
      } catch (e) {}
      throw new Error(err);
    }
    return res.status === 204 ? undefined : res.json();
  }

  // Authentication
  async function doLogin(user, tenant, apiKey) {
    try {
      var res = await fetch("/api/v1/auth/token", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ apiKey: apiKey, tenant: tenant, user: user, role: "user" })
      });
      var data = await res.json();
      if (!res.ok) throw new Error(data.error?.message || "登录失败");

      token = data.token;
      currentUser = data.sub;
      currentTenant = data.tenant;
      localStorage.setItem("oc_token", token);
      localStorage.setItem("oc_user", currentUser);
      localStorage.setItem("oc_tenant", currentTenant);

      updateUserDisplay(currentUser, currentTenant, data.role || "user");
      $("loginModal").classList.remove("open");
      toast("欢迎回来，" + currentUser + "！", "success");

      await refreshAll();
      if (sessions.length > 0) {
        selectSession(sessions[0].id);
      }
    } catch (e) {
      toast(e.message, "error");
    }
  }

  function updateUserDisplay(user, tenant, role) {
    $("userName").textContent = user;
    $("userAvatar").textContent = user.slice(0, 1).toUpperCase();
    $("userTenant").textContent = tenant;
    $("userRole").textContent = role;
    $("insUserId").textContent = user;
  }

  function logout() {
    token = null;
    localStorage.removeItem("oc_token");
    sessions = [];
    currentSessionId = null;
    stopStream();
    renderSessionList();
    $("messagesContainer").innerHTML = "";
    $("welcomeCard").style.display = "block";
    $("messagesContainer").appendChild($("welcomeCard"));
    $("chatTitle").textContent = "选择或创建一个会话";
    $("chatSessionId").textContent = "ID: —";
    $("chatWorkerId").textContent = "节点: —";
    $("composer").disabled = true;
    $("sendButton").disabled = true;
    $("loginModal").classList.add("open");
  }

  // Sessions Management
  async function refreshSessions() {
    try {
      var data = await api("GET", "/api/v1/sessions");
      sessions = data.sessions || [];
      $("sessionCount").textContent = sessions.length;
      renderSessionList();
    } catch (e) {
      toast("拉取会话失败: " + e.message, "error");
    }
  }

  function renderSessionList() {
    var filter = $("sessionSearch").value.toLowerCase().trim();
    var list = $("sessionList");
    list.innerHTML = "";

    var filtered = sessions.filter(function(s) { return (s.title || "").toLowerCase().includes(filter); });
    if (filtered.length === 0) {
      list.innerHTML = '<li style="padding:20px 10px;text-align:center;color:var(--text-dim);font-size:12px">暂无匹配会话</li>';
      return;
    }

    for (var i = 0; i < filtered.length; i++) {
      var s = filtered[i];
      var isSched = (s.title || "").indexOf("⏰") !== -1;
      var li = document.createElement("li");
      li.className = "session-item " + (s.id === currentSessionId ? "active" : "");
      li.innerHTML =
        '<div class="session-title-row">' +
          '<span class="session-title">' + escapeHtml(s.title || "未命名会话") + '</span>' +
          (isSched ? '<span class="schedule-badge">定时</span>' : '') +
        '</div>' +
        '<div class="session-meta-row">' +
          '<span class="status-dot ' + escapeHtml(s.status || '') + '"></span>' +
          '<span>' + escapeHtml(s.status || 'assigned') + '</span>' +
          '<span>·</span>' +
          '<span>' + new Date(s.updatedAt || s.createdAt).toLocaleTimeString([], {hour:"2-digit", minute:"2-digit"}) + '</span>' +
        '</div>' +
        '<div class="session-actions">' +
          '<button class="action-icon-btn" title="重命名" onclick="openRenameModal(\'' + s.id + '\', \'' + escapeHtml(s.title || '') + '\', event)">✏️</button>' +
          '<button class="action-icon-btn danger" title="删除/结束" onclick="deleteSession(\'' + s.id + '\', event)">🗑️</button>' +
        '</div>';
      (function(sessionId) {
        li.onclick = function() { selectSession(sessionId); };
      })(s.id);
      list.appendChild(li);
    }
  }

  async function createNewSession(title) {
    try {
      var res = await api("POST", "/api/v1/sessions", {
        title: title || ("新会话 · " + new Date().toLocaleTimeString([], {hour:"2-digit", minute:"2-digit"}))
      });
      await refreshSessions();
      await selectSession(res.session.id);
      $("composer").focus();
    } catch (e) {
      toast("创建会话失败: " + e.message, "error");
    }
  }

  window.openRenameModal = function(id, currentTitle, e) {
    e.stopPropagation();
    $("renameSessionId").value = id;
    $("renameTitleInput").value = currentTitle;
    $("renameModal").classList.add("open");
    $("renameTitleInput").focus();
  };

  window.deleteSession = async function(id, e) {
    e.stopPropagation();
    if (!confirm("确定要结束并删除此会话吗？")) return;
    try {
      await api("DELETE", "/api/v1/sessions/" + id);
      toast("会话已结束", "success");
      await refreshSessions();
      if (currentSessionId === id) {
        if (sessions.length > 0) selectSession(sessions[0].id);
        else logout();
      }
    } catch (err) {
      toast("删除失败: " + err.message, "error");
    }
  };

  // Chat & Transcript
  async function selectSession(id) {
    currentSessionId = id;
    renderSessionList();

    var s = sessions.find(function(item) { return item.id === id; });
    $("chatTitle").textContent = s?.title || "会话";
    $("chatSessionId").textContent = "ID: " + id.slice(0, 10) + "...";
    $("chatWorkerId").textContent = "节点: " + (s?.ownerWorkerId || "—");
    $("insSessionId").textContent = id;
    $("insWorker").textContent = s?.ownerWorkerId || "—";
    $("insStatus").textContent = s?.status || "ok";

    $("composer").disabled = false;
    $("sendButton").disabled = false;
    $("btnStop").disabled = false;

    $("messagesContainer").innerHTML = "";
    await loadMessages(id);
    startStream(id);
  }

  async function loadMessages(sessionId) {
    try {
      var res = await api("GET", "/api/v1/sessions/" + sessionId + "/messages");
      var msgs = res.messages || [];
      if (msgs.length === 0) {
        $("welcomeCard").style.display = "block";
        $("messagesContainer").appendChild($("welcomeCard"));
      } else {
        $("welcomeCard").style.display = "none";
        for (var i = 0; i < msgs.length; i++) {
          var m = msgs[i];
          if (m.role === "tool") appendToolCard(m.name, m.content);
          else appendMessage(m.role || "assistant", m.content, m);
        }
      }
      scrollToBottom();
    } catch (e) {
      toast("加载历史消息失败: " + e.message, "error");
    }
  }

  function appendMessage(role, content, extra) {
    extra = extra || {};
    $("welcomeCard").style.display = "none";
    var row = document.createElement("div");
    row.className = "message-row " + role;

    var isUser = role === "user";
    var avatarLetter = isUser ? currentUser.slice(0, 1).toUpperCase() : "AI";
    var nameLabel = isUser ? currentUser : "OpenCode";

    var thinkingHtml = "";
    if (extra.reasoning) {
      thinkingHtml =
        '<div class="thinking-panel">' +
          '<div class="thinking-header" onclick="this.nextElementSibling.classList.toggle(\\'hidden\\')">' +
            '<span>🧠 思考过程</span>' +
          '</div>' +
          '<div class="thinking-content">' + escapeHtml(extra.reasoning) + '</div>' +
        '</div>';
    }

    row.innerHTML =
      '<div class="message-avatar">' + avatarLetter + '</div>' +
      '<div class="message-body">' +
        '<div class="message-header-label">' + nameLabel + '</div>' +
        thinkingHtml +
        '<div class="bubble">' + (isUser ? escapeHtml(content) : renderMarkdown(content)) + '</div>' +
      '</div>';

    $("messagesContainer").appendChild(row);
    scrollToBottom();
    return row;
  }

  function appendToolCard(toolName, content) {
    $("welcomeCard").style.display = "none";
    var card = document.createElement("div");
    card.className = "tool-card";
    card.innerHTML =
      '<div class="tool-header">' +
        '<span>⚙️ 工具调用 · ' + escapeHtml(toolName || "tool") + '</span>' +
      '</div>' +
      '<div class="tool-content">' + escapeHtml(content || "") + '</div>';
    $("messagesContainer").appendChild(card);
    scrollToBottom();
  }

  function getOrDraftAssistantBubble() {
    var draft = $("streamDraft");
    if (draft) return draft;

    $("welcomeCard").style.display = "none";
    draft = document.createElement("div");
    draft.id = "streamDraft";
    draft.className = "message-row assistant";
    draft.innerHTML =
      '<div class="message-avatar">AI</div>' +
      '<div class="message-body">' +
        '<div class="message-header-label">OpenCode · 处理中...</div>' +
        '<div class="thinking-panel" id="draftThinkingPanel" style="display:none">' +
          '<div class="thinking-header"><span>🧠 思考过程</span></div>' +
          '<div class="thinking-content" id="draftThinkingText"></div>' +
        '</div>' +
        '<div class="bubble" id="draftBubbleText"></div>' +
      '</div>';
    $("messagesContainer").appendChild(draft);
    return draft;
  }

  let lastEventID=null,displayedQuestionIDs=new Set();

  function renderQuestionCard(data) {
    var interaction = data;
    if (!interaction?.id || displayedQuestionIDs.has(interaction.id))return;
    displayedQuestionIDs.add(interaction.id);

    var questions = data?.request?.questions;
    if (!Array.isArray(questions) || !questions.length) return;

    var card = document.createElement("div");
    card.className = "question-card";
    card.id = "question-" + (data.id || Date.now());

    var qHtml = "";
    questions.forEach(function(q, qIdx) {
      var opts = Array.isArray(q.options) ? q.options : [];
      qHtml += '<div style="margin-bottom:10px">' +
        '<div style="font-weight:600;margin-bottom:6px">' + escapeHtml(q.question || "请选择：") + '</div>' +
        '<div class="question-options-group">' +
          opts.map(function(opt) {
            var label = escapeHtml(opt.label || opt);
            return '<button type="button" class="question-btn" data-qidx="' + qIdx + '" data-val="' + label + '">' + label + '</button>';
          }).join("") +
        '</div>' +
      '</div>';
    });

    card.innerHTML =
      '<div class="question-title">❓ 需要你的确认</div>' +
      qHtml +
      '<button class="btn-submit-answer" id="btnSubmitAnswers" disabled>提交回答</button>';

    var selectedAnswers = {};
    card.querySelectorAll(".question-btn").forEach(function(b) {
      b.onclick = function() {
        var qIdx = b.dataset.qidx;
        card.querySelectorAll('.question-btn[data-qidx="' + qIdx + '"]').forEach(function(el) { el.classList.remove("selected"); });
        b.classList.add("selected");
        selectedAnswers[qIdx] = b.dataset.val;
        card.querySelector("#btnSubmitAnswers").disabled = Object.keys(selectedAnswers).length < questions.length;
      };
    });

    card.querySelector("#btnSubmitAnswers").onclick = async function() {
      card.querySelector("#btnSubmitAnswers").disabled = true;
      card.querySelector("#btnSubmitAnswers").textContent = "正在提交...";
      try {
        var answersArr = [];
        for (var k in selectedAnswers) { answersArr.push([selectedAnswers[k]]); }
        await api("POST", "/api/v1/sessions/" + currentSessionId + "/control", {
          type: "question.reply",
          data: {
            interactionID: data.id,
            answer: { answers: answersArr }
          }
        });
        card.innerHTML = '<div style="color:var(--success);font-weight:600">✅ 确认信息已提交，Agent 正在继续工作...</div>';
      } catch (err) {
        toast("提交失败: " + err.message, "error");
      }
    };

    $("messagesContainer").appendChild(card);
    scrollToBottom();
  }

  // Streaming SSE
  function stopStream() {
    if (eventSourceController) {
      eventSourceController.abort();
      eventSourceController = null;
    }
  }

  function startStream(sessionId) {
    stopStream();
    if (!sessionId || !token) return;

    setConnectionState("running", "连接中...");
    var controller = new AbortController();
    eventSourceController = controller;

    (async function() {
      try {
        var resp = await fetch("/api/v1/sessions/" + sessionId + "/events", {
          headers:{authorization:"Bearer "+token,...(lastEventID?{"last-event-id":lastEventID}:{})},
          signal: controller.signal
        });
        if (!resp.ok) throw new Error("无法建立事件流");

        setConnectionState("ok", "已连接");
        var reader = resp.body.getReader();
        var decoder = new TextDecoder();
        var buffer = "";

        while (!controller.signal.aborted) {
          var chunk = await reader.read();
          if (chunk.done) break;
          buffer += decoder.decode(chunk.value, { stream: true });
          var frames = buffer.split("\\n\\n");
          buffer = frames.pop() || "";

          for (var i = 0; i < frames.length; i++) {
            var frame = frames[i];
            var dataStr = null;
            var lines = frame.split("\\n");
            for (var j = 0; j < lines.length; j++) {
              var line = lines[j];
              if(line.startsWith("id: "))lastEventID=line.slice(4).trim();
              if (line.indexOf("data: ") === 0) dataStr = line.slice(6);
            }
            if (dataStr) {
              try {
                handleServerEvent(JSON.parse(dataStr));
              } catch (e) {}
            }
          }
        }
      } catch (e) {
        if (!controller.signal.aborted) {
          setConnectionState("recovering", "连接重试中");
          setTimeout(function() { if (currentSessionId === sessionId) startStream(sessionId); }, 2000);
        }
      }
    })();
  }

  function handleServerEvent(event) {
    if (!event || event.sessionID !== currentSessionId) return;
    var data = event.data || {};

    if (event?.type==="worker.question.resolved") {
      document.getElementById("question-"+data.interactionID)?.remove();
      return;
    }

    if (event.type === "session.next.reasoning.delta") {
      var draft = getOrDraftAssistantBubble();
      var panel = draft.querySelector("#draftThinkingPanel");
      panel.style.display = "block";
      draft.querySelector("#draftThinkingText").textContent += String(data.delta || "");
      scrollToBottom();
      return;
    }

    if (event.type === "session.next.text.delta") {
      var draft = getOrDraftAssistantBubble();
      var target = draft.querySelector("#draftBubbleText");
      var text = (target.dataset.rawText = (target.dataset.rawText || "") + String(data.delta || ""));
      target.innerHTML = renderMarkdown(text);
      scrollToBottom();
      return;
    }

    if (event.type === "worker.question.snapshot") {
      $("streamDraft")?.removeAttribute("id");
      renderQuestionCard(data);
      return;
    }

    if (event.type === "worker.turn.message") {
      $("streamDraft")?.remove();
      if (data.role === "tool") renderTool(data);
      else appendMessage(data.role || "assistant", data.content, data);
      return;
    }

    if (event.type === "session.idle") {
      $("streamDraft")?.removeAttribute("id");
      setConnectionState("ok", "就绪");
      refreshSessions();
      return;
    }

    if (event.type === "worker.execution.error") {
      $("streamDraft")?.remove();
      toast(data.message || "Agent 执行异常", "error");
      setConnectionState("recovering", "出错");
      return;
    }
  }

  function scrollToBottom() {
    var scroller = $("messageScroller");
    scroller.scrollTop = scroller.scrollHeight;
  }

  // Sending Prompts
  async function sendPrompt() {
    var text = $("composer").value.trim();
    if (!text || !currentSessionId || isSending) return;

    isSending = true;
    $("sendButton").disabled = true;
    $("composer").value = "";
    $("composer").style.height = "auto";

    appendMessage("user", text);

    try {
      await api("POST", "/api/v1/sessions/" + currentSessionId + "/prompt", { content: text });
      setConnectionState("running", "Agent 运行中...");
    } catch (e) {
      toast("发送失败: " + e.message, "error");
    } finally {
      isSending = false;
      $("sendButton").disabled = false;
      $("composer").focus();
    }
  }

  // Workers inspection
  async function refreshWorkers() {
    try {
      var data = await api("GET", "/api/v1/nodes");
      var c = $("workerListContainer");
      c.innerHTML = "";
      var nodes = data.nodes || [];
      if (!nodes.length) {
        c.innerHTML = '<span style="color:var(--text-dim);font-size:12px">暂无在线计算节点</span>';
        return;
      }
      for (var i = 0; i < nodes.length; i++) {
        var n = nodes[i];
        var item = document.createElement("div");
        item.className = "worker-card-item";
        item.innerHTML =
          '<div class="worker-name">' +
            '<span class="status-dot ' + n.status + '"></span>' +
            '<span>' + escapeHtml(n.id) + '</span>' +
          '</div>' +
          '<div class="worker-load-meta">' +
            (n.region || "default") + " · 活跃会话: " + (n.load?.activeDrains || 0) +
          '</div>';
        c.appendChild(item);
      }
    } catch (e) {}
  }

  async function refreshAll() {
    await Promise.all([refreshSessions(), refreshWorkers()]);
  }

  // DOM Events Binding
  window.addEventListener("DOMContentLoaded", function() {
    // Check login
    if (!token) {
      $("loginModal").classList.add("open");
    } else {
      updateUserDisplay(currentUser, currentTenant, "user");
      refreshAll().then(function() {
        if (sessions.length > 0) selectSession(sessions[0].id);
      });
    }

    // Quick user selection
    document.querySelectorAll(".quick-user-chip").forEach(function(chip) {
      chip.onclick = function() {
        $("loginUser").value = chip.dataset.user;
        $("loginTenant").value = chip.dataset.tenant;
        $("loginApiKey").value = "dev-admin-key";
      };
    });

    // Login submit
    $("loginForm").onsubmit = function(e) {
      e.preventDefault();
      doLogin($("loginUser").value.trim(), $("loginTenant").value.trim(), $("loginApiKey").value.trim());
    };

    $("btnLogout").onclick = logout;

    // New Session
    $("newSession").onclick = function() { createNewSession(); };

    // Session search filter
    $("sessionSearch").oninput = renderSessionList;

    // Send button & composer
    $("sendButton").onclick = sendPrompt;
    $("composer").onkeydown = function(e) {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        sendPrompt();
      }
    };
    $("composer").oninput = function() {
      var el = $("composer");
      el.style.height = "auto";
      el.style.height = Math.min(el.scrollHeight, 180) + "px";
    };

    // Stop button
    $("btnStop").onclick = async function() {
      if (!currentSessionId) return;
      try {
        await api("POST", "/api/v1/sessions/" + currentSessionId + "/stop");
        toast("已发送停止指令", "success");
        await refreshSessions();
      } catch (e) {
        toast("停止失败: " + e.message, "error");
      }
    };

    // Rename form
    $("renameForm").onsubmit = async function(e) {
      e.preventDefault();
      var id = $("renameSessionId").value;
      var title = $("renameTitleInput").value.trim();
      if (!id || !title) return;
      try {
        await api("PATCH", "/api/v1/sessions/" + id, { title: title });
        toast("会话已重命名", "success");
        $("renameModal").classList.remove("open");
        await refreshSessions();
        if (currentSessionId === id) $("chatTitle").textContent = title;
      } catch (err) {
        toast("重命名失败: " + err.message, "error");
      }
    };
    $("btnCancelRename").onclick = function() { $("renameModal").classList.remove("open"); };

    // Suggestion prompts
    document.querySelectorAll(".suggestion-btn").forEach(function(btn) {
      btn.onclick = function() {
        if (!currentSessionId) {
          createNewSession().then(function() {
            $("composer").value = btn.dataset.prompt;
            sendPrompt();
          });
        } else {
          $("composer").value = btn.dataset.prompt;
          sendPrompt();
        }
      };
    });

    // Auto refresh workers
    setInterval(function() {
      if (token) refreshWorkers();
    }, 12000);
  });
</script>
</body>
</html>`;
}
