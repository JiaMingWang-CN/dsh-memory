/**
 * Visual language for the Memory settings page.
 *
 * Everything is expressed as one injected stylesheet rather than inline
 * styles: real `:hover`, `:focus-visible`, media queries and keyframes are not
 * expressible inline, and a single shared stylesheet keeps the component tree
 * cheap to render. Only host theme tokens (`--dsw-alias-*`, `--dsw-radius-*`,
 * `--dsw-focus-ring-*`) are referenced, so light/dark and every accent follow
 * the application automatically.
 * @module dsh-memory/client/styles
 */
import * as React from 'react'
import { t } from './locales.ts'

const h = React.createElement

const BASE_CSS = `
.dsh-mem-page {
  display: flex;
  flex-direction: column;
  gap: 14px;
  max-width: 960px;
  padding-bottom: 20px;
  color: var(--dsw-alias-label-primary);
}
.dsh-mem-header-row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}
.dsh-mem-head { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.dsh-mem-title { margin: 0; font-size: 18px; line-height: 26px; font-weight: 600; }
.dsh-mem-intro { margin: 0; font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-tertiary); }
.dsh-mem-header-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dsh-mem-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border: 0.5px solid var(--dsw-alias-settings-card-stroke);
  border-radius: var(--dsw-radius-xl);
  background: var(--dsw-alias-settings-card-fill);
}
.dsh-mem-toolbar-spacer { flex: 1 1 auto; }
.dsh-mem-stats { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.dsh-mem-stat {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 10px;
  border: 0.5px solid transparent;
  border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-bg-module-platform);
  font: inherit;
  font-size: 12px;
  color: var(--dsw-alias-label-secondary);
}
button.dsh-mem-stat { cursor: pointer; }
@media (hover: hover) {
  button.dsh-mem-stat:hover {
    background: var(--dsw-alias-interactive-bg-hover);
    border-color: var(--dsw-alias-border-l2);
  }
}
button.dsh-mem-stat:focus-visible {
  outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: 1px;
}
.dsh-mem-stat strong { font-weight: 600; color: var(--dsw-alias-label-primary); font-variant-numeric: tabular-nums; }
.dsh-mem-index-meter {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  height: 28px;
  padding: 0 10px;
  border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-bg-module-platform);
  font-size: 12px;
  color: var(--dsw-alias-label-secondary);
  font-variant-numeric: tabular-nums;
}
.dsh-mem-meter-track {
  width: 52px;
  height: 5px;
  border-radius: 999px;
  overflow: hidden;
  background: var(--dsw-alias-bg-layer-3);
}
.dsh-mem-meter-fill {
  height: 100%;
  border-radius: 999px;
  background: var(--dsw-alias-brand-primary);
  transition: width 180ms ease;
}
.dsh-mem-meter-fill[data-tone="warn"] { background: var(--dsw-alias-state-warn-primary); }
.dsh-mem-meter-fill[data-tone="error"] { background: var(--dsw-alias-state-error-primary); }
.dsh-mem-dot { width: 7px; height: 7px; border-radius: 50%; flex: none; background: var(--dsw-alias-label-tertiary); }
.dsh-mem-dot[data-tone="success"] { background: var(--dsw-alias-state-success-primary); }
.dsh-mem-dot[data-tone="warn"] { background: var(--dsw-alias-state-warn-primary); }
.dsh-mem-dot[data-tone="error"] { background: var(--dsw-alias-state-error-primary); }
.dsh-mem-dot[data-tone="idle"] { background: var(--dsw-alias-state-idle-primary); }
.dsh-mem-dot[data-pulse="true"] { animation: dsh-mem-pulse 1.2s ease-in-out infinite; }
.dsh-mem-tabs {
  display: flex;
  align-items: center;
  gap: 4px;
  border-bottom: 0.5px solid var(--dsw-alias-border-l2);
  overflow-x: auto;
}
.dsh-mem-tab {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 36px;
  padding: 0 12px;
  border: 0;
  border-bottom: 2px solid transparent;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  font-size: 13px;
  font-weight: 500;
  white-space: nowrap;
  cursor: pointer;
}
@media (hover: hover) {
  .dsh-mem-tab:hover { color: var(--dsw-alias-label-primary); }
}
.dsh-mem-tab[aria-selected="true"] {
  color: var(--dsw-alias-label-primary);
  border-bottom-color: var(--dsw-alias-brand-primary);
  font-weight: 600;
}
.dsh-mem-tab:focus-visible {
  outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: -2px;
  border-radius: var(--dsw-radius-sm);
}
.dsh-mem-tab-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 16%, transparent);
  color: var(--dsw-alias-state-warn-primary);
  font-size: 11px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.dsh-mem-tab-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--dsw-alias-brand-primary);
}
.dsh-mem-tabpanel { display: flex; flex-direction: column; gap: 14px; min-width: 0; }
.dsh-mem-warning {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-state-warn-tertiary);
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-secondary);
}
.dsh-mem-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 8px 12px;
  border-radius: var(--dsw-radius-md);
  font-size: 12px;
  line-height: 18px;
  overflow-wrap: anywhere;
}
.dsh-mem-banner[data-tone="notice"] {
  background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 10%, transparent);
  color: var(--dsw-alias-label-secondary);
}
.dsh-mem-banner[data-tone="error"] {
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 8%, transparent);
  color: var(--dsw-alias-state-error-primary);
}
.dsh-mem-card {
  display: flex;
  flex-direction: column;
  min-width: 0;
  border: 0.5px solid var(--dsw-alias-settings-card-stroke);
  border-radius: var(--dsw-radius-xl);
  background: var(--dsw-alias-settings-card-fill);
}
.dsh-mem-pane-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 12px 14px;
  border-bottom: 0.5px solid var(--dsw-alias-border-l2);
}
.dsh-mem-pane-title { font-size: 13px; font-weight: 600; line-height: 20px; }
.dsh-mem-count { font-size: 12px; color: var(--dsw-alias-label-tertiary); font-variant-numeric: tabular-nums; }
.dsh-mem-filters {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px 14px;
  border-bottom: 0.5px solid var(--dsw-alias-border-l2);
}
.dsh-mem-search-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dsh-mem-search-wrap { position: relative; flex: 1 1 220px; min-width: 0; display: flex; align-items: center; }
.dsh-mem-search-icon {
  position: absolute;
  left: 10px;
  color: var(--dsw-alias-label-tertiary);
  pointer-events: none;
  display: inline-flex;
}
.dsh-mem-search-input {
  width: 100%;
  box-sizing: border-box;
  height: 32px;
  padding: 0 30px 0 30px;
  border: 0.5px solid var(--dsw-alias-border-l4);
  border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-bg-layer-3);
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 13px;
}
.dsh-mem-search-input:focus {
  outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-brand-primary));
  outline-offset: 0;
  border-color: var(--dsw-alias-state-business-primary);
}
.dsh-mem-search-clear {
  position: absolute;
  right: 4px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border: 0;
  border-radius: var(--dsw-radius-sm);
  background: transparent;
  color: var(--dsw-alias-label-tertiary);
  cursor: pointer;
}
@media (hover: hover) { .dsh-mem-search-clear:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); } }
.dsh-mem-filter-bars { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 14px; }
.dsh-mem-pill-group { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 4px; }
.dsh-mem-pill-label { font-size: 11px; color: var(--dsw-alias-label-tertiary); margin-inline-end: 2px; }
.dsh-mem-pill {
  display: inline-flex;
  align-items: center;
  height: 24px;
  padding: 0 9px;
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: 999px;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
  white-space: nowrap;
}
@media (hover: hover) {
  .dsh-mem-pill:hover {
    background: var(--dsw-alias-interactive-bg-hover);
    color: var(--dsw-alias-label-primary);
  }
}
.dsh-mem-pill[aria-pressed="true"] {
  background: color-mix(in srgb, var(--dsw-alias-brand-primary) 14%, transparent);
  border-color: color-mix(in srgb, var(--dsw-alias-brand-primary) 45%, transparent);
  color: var(--dsw-alias-brand-primary);
  font-weight: 500;
}
.dsh-mem-pill:focus-visible {
  outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: 1px;
}
.dsh-mem-rows { display: flex; flex-direction: column; flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 6px; margin: 0; list-style: none; }
.dsh-mem-row-item { list-style: none; }
.dsh-mem-row {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  width: 100%;
  padding: 10px 12px;
  border: 0;
  border-inline-start: 2px solid transparent;
  border-radius: var(--dsw-radius-md);
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition: background 120ms ease;
}
.dsh-mem-row .dsh-mem-dot { margin-top: 6px; }
.dsh-mem-row-item + .dsh-mem-row-item { margin-top: 2px; }
@media (hover: hover) { .dsh-mem-row:hover { background: var(--dsw-alias-interactive-bg-hover); } }
.dsh-mem-row[aria-current="true"] {
  background: var(--dsw-alias-bg-module-platform);
  border-inline-start-color: var(--dsw-alias-brand-primary);
}
.dsh-mem-row:focus-visible {
  outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: -1px;
}
.dsh-mem-row-main { display: flex; flex-direction: column; gap: 3px; flex: 1; min-width: 0; }
.dsh-mem-row-top { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-width: 0; }
.dsh-mem-row-title {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 13px;
  line-height: 19px;
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}
.dsh-mem-row-excerpt { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-mem-row-meta { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-top: 2px; }
.dsh-mem-pin { display: inline-flex; align-items: center; color: var(--dsw-alias-state-warn-primary); flex: none; }
.dsh-mem-tag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  max-width: 100%;
  height: 19px;
  padding: 0 7px;
  border-radius: var(--dsw-radius-sm);
  background: var(--dsw-alias-bg-layer-3);
  color: var(--dsw-alias-label-secondary);
  font-size: 11px;
  line-height: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.dsh-mem-tag[data-tone="warn"] { color: var(--dsw-alias-state-warn-primary); background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 12%, transparent); }
.dsh-mem-tag[data-tone="success"] { color: var(--dsw-alias-state-success-primary); background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 10%, transparent); }
.dsh-mem-tag[data-tone="error"] { color: var(--dsw-alias-state-error-primary); background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent); }
.dsh-mem-tag[data-tone="accent"] { color: var(--dsw-alias-brand-primary); background: color-mix(in srgb, var(--dsw-alias-brand-primary) 12%, transparent); }
.dsh-mem-detail { display: flex; flex-direction: column; gap: 14px; }
.dsh-mem-detail-head { display: flex; flex-direction: column; gap: 6px; }
.dsh-mem-detail-title { margin: 0; font-size: 16px; line-height: 24px; font-weight: 600; overflow-wrap: anywhere; }
.dsh-mem-detail-tags { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.dsh-mem-body-box {
  position: relative;
  padding: 12px 14px;
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: var(--dsw-radius-lg);
  background: var(--dsw-alias-bg-module-platform);
}
.dsh-mem-body-tools { display: flex; justify-content: flex-end; margin-bottom: 6px; }
.dsh-mem-body { white-space: pre-wrap; font-size: 13px; line-height: 1.65; overflow-wrap: anywhere; }
.dsh-mem-facts {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(110px, 1fr));
  gap: 10px 14px;
  margin: 0;
  padding: 12px 14px;
  border-radius: var(--dsw-radius-lg);
  background: var(--dsw-alias-bg-module-platform);
}
.dsh-mem-fact { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.dsh-mem-fact dt { font-size: 11px; color: var(--dsw-alias-label-tertiary); }
.dsh-mem-fact dd { margin: 0; font-size: 13px; font-weight: 500; overflow-wrap: anywhere; font-variant-numeric: tabular-nums; }
.dsh-mem-source-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 20px;
  padding: 0 7px;
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: var(--dsw-radius-sm);
  background: var(--dsw-alias-bg-layer-3);
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  font-size: 11px;
  cursor: pointer;
}
@media (hover: hover) { .dsh-mem-source-btn:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); } }
.dsh-mem-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.dsh-mem-footer-split { display: flex; align-items: center; justify-content: space-between; gap: 8px; width: 100%; flex-wrap: wrap; }
.dsh-mem-confirm {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 9px 12px;
  border-radius: var(--dsw-radius-md);
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 8%, transparent);
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-state-error-primary);
  overflow-wrap: anywhere;
}
.dsh-mem-notice {
  margin: 0;
  padding: 8px 12px;
  border-radius: var(--dsw-radius-md);
  background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 10%, transparent);
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  line-height: 18px;
  overflow-wrap: anywhere;
}
.dsh-mem-pager {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  border-top: 0.5px solid var(--dsw-alias-border-l2);
}
.dsh-mem-pager .dsh-mem-count { margin-inline-end: auto; }
.dsh-mem-mapping { display: flex; flex-direction: column; gap: 8px; padding-top: 4px; }
.dsh-mem-report {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 10px 12px;
  border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-bg-module-platform);
  font-size: 12px;
  line-height: 18px;
  overflow-wrap: anywhere;
}
.dsh-mem-report p { margin: 0; }
.dsh-mem-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 30px;
  padding: 0 12px;
  border: 0.5px solid var(--dsw-alias-border-l4);
  border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-bg-layer-3);
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 13px;
  line-height: 1;
  white-space: nowrap;
  cursor: pointer;
}
@media (hover: hover) { .dsh-mem-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); } }
.dsh-mem-btn:active:not(:disabled) { background: var(--dsw-alias-interactive-bg-active); }
.dsh-mem-btn:focus-visible {
  outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: 1px;
}
.dsh-mem-btn:disabled { opacity: 0.5; cursor: default; }
.dsh-mem-btn[data-variant="primary"] { background: var(--dsw-alias-brand-primary); border-color: transparent; color: var(--dsw-alias-label-primary-foreground); }
@media (hover: hover) { .dsh-mem-btn[data-variant="primary"]:hover:not(:disabled) { background: var(--dsw-alias-brand-primary); filter: brightness(1.07); } }
.dsh-mem-btn[data-variant="ghost"] { background: transparent; border-color: transparent; color: var(--dsw-alias-label-secondary); }
@media (hover: hover) { .dsh-mem-btn[data-variant="ghost"]:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); } }
.dsh-mem-btn[data-variant="danger"] { background: transparent; border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 35%, transparent); color: var(--dsw-alias-state-error-primary); }
@media (hover: hover) { .dsh-mem-btn[data-variant="danger"]:hover:not(:disabled) { background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 8%, transparent); } }
.dsh-mem-btn[data-size="sm"] { height: 26px; padding: 0 9px; font-size: 12px; }
.dsh-mem-iconbtn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: 0;
  border-radius: var(--dsw-radius-sm);
  background: transparent;
  color: var(--dsw-alias-label-caption);
  cursor: pointer;
}
@media (hover: hover) { .dsh-mem-iconbtn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); } }
.dsh-mem-iconbtn:disabled { opacity: 0.5; cursor: default; }
.dsh-mem-select { position: relative; display: inline-flex; max-width: 100%; }
.dsh-mem-trigger {
  display: inline-flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  height: 30px;
  min-width: 140px;
  max-width: 280px;
  padding: 0 10px;
  border: 0.5px solid var(--dsw-alias-border-l4);
  border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-bg-layer-3);
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 12.5px;
  cursor: pointer;
}
@media (hover: hover) { .dsh-mem-trigger:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); } }
.dsh-mem-trigger:focus-visible {
  outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-brand-primary));
  outline-offset: 1px;
}
.dsh-mem-trigger[aria-expanded="true"] { border-color: var(--dsw-alias-state-business-primary); }
.dsh-mem-trigger:disabled { opacity: 0.55; cursor: default; }
.dsh-mem-trigger-value { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-mem-chevron { flex: none; color: var(--dsw-alias-label-tertiary); transition: transform 150ms ease; }
.dsh-mem-trigger[aria-expanded="true"] .dsh-mem-chevron { transform: rotate(180deg); }
.dsh-mem-menu {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  z-index: 60;
  min-width: 100%;
  max-height: 260px;
  overflow-y: auto;
  padding: 5px;
  border: 0.5px solid var(--dsw-alias-border-l1);
  border-radius: var(--dsw-radius-lg);
  background: var(--dsw-alias-bg-overlay);
  box-shadow: var(--dsw-elevation-prominent);
}
.dsh-mem-menu[data-placement="top"] {
  top: auto;
  bottom: calc(100% + 4px);
}
.dsh-mem-menu-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  width: 100%;
  height: 30px;
  padding: 0 9px;
  border: 0;
  border-radius: var(--dsw-radius-sm);
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 12.5px;
  text-align: left;
  white-space: nowrap;
  cursor: pointer;
}
@media (hover: hover) { .dsh-mem-menu-item:hover { background: var(--dsw-alias-interactive-bg-hover); } }
.dsh-mem-menu-item[aria-checked="true"] { font-weight: 500; }
.dsh-mem-menu-item span { overflow: hidden; text-overflow: ellipsis; }
.dsh-mem-menu-check { flex: none; color: var(--dsw-alias-brand-primary); }
.dsh-mem-switchrow { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 10px 0; }
.dsh-mem-switchrow + .dsh-mem-switchrow,
.dsh-mem-setting-row + .dsh-mem-setting-row,
.dsh-mem-switchrow + .dsh-mem-setting-row,
.dsh-mem-setting-row + .dsh-mem-switchrow { border-top: 0.5px solid var(--dsw-alias-border-l2); }
.dsh-mem-setting-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 10px 0;
}
.dsh-mem-setting-row[data-dim="true"] { opacity: 0.55; }
.dsh-mem-setting-control { flex: none; min-width: 140px; max-width: 280px; display: flex; justify-content: flex-end; }
.dsh-mem-setting-control .dsh-mem-field { padding: 0; width: 160px; }
.dsh-mem-setting-control .dsh-mem-label { display: none; }
.dsh-mem-switchtext { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.dsh-mem-switchlabel { font-size: 13px; line-height: 20px; font-weight: 500; }
.dsh-mem-switchhint { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
.dsh-mem-switch {
  position: relative;
  flex: none;
  width: 34px;
  height: 20px;
  padding: 0;
  border: 0.5px solid var(--dsw-alias-border-l4);
  border-radius: 999px;
  background: var(--dsw-alias-bg-layer-3);
  cursor: pointer;
}
.dsh-mem-switch::after {
  content: '';
  position: absolute;
  top: 2px;
  left: 2px;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: var(--dsw-alias-label-secondary);
  transition: transform 150ms ease, background 150ms ease;
}
.dsh-mem-switch[aria-checked="true"] { background: var(--dsw-alias-brand-primary); border-color: transparent; }
.dsh-mem-switch[aria-checked="true"]::after { transform: translateX(14px); background: var(--dsw-alias-label-primary-foreground); }
.dsh-mem-switch:focus-visible { outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline-offset: 2px; }
.dsh-mem-switch:disabled { opacity: 0.5; cursor: default; }
.dsh-mem-field { display: flex; flex-direction: column; gap: 5px; padding: 8px 0; }
.dsh-mem-field + .dsh-mem-field { border-top: 0.5px solid var(--dsw-alias-border-l2); }
.dsh-mem-form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
.dsh-mem-form-grid .dsh-mem-field { padding: 0; border-top: 0; }
.dsh-mem-form-grid .dsh-mem-trigger { width: 100%; max-width: none; }
.dsh-mem-label { font-size: 13px; line-height: 20px; font-weight: 500; }
.dsh-mem-hint { margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
.dsh-mem-input {
  width: 100%;
  box-sizing: border-box;
  height: 32px;
  padding: 0 10px;
  border: 0.5px solid var(--dsw-alias-border-l4);
  border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-bg-layer-3);
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 13px;
}
textarea.dsh-mem-input { height: auto; min-height: 140px; padding: 8px 10px; line-height: 1.6; resize: vertical; }
.dsh-mem-input:focus {
  outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-brand-primary));
  outline-offset: 0;
  border-color: var(--dsw-alias-state-business-primary);
}
.dsh-mem-input[aria-invalid="true"] { border-color: var(--dsw-alias-state-error-primary); }
.dsh-mem-chips { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 4px; }
.dsh-mem-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 22px;
  padding: 0 6px 0 8px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--dsw-alias-brand-primary) 12%, transparent);
  color: var(--dsw-alias-label-primary);
  font-size: 12px;
}
.dsh-mem-chip-x {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  border: 0;
  border-radius: 50%;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  font-size: 12px;
  line-height: 1;
  cursor: pointer;
}
@media (hover: hover) { .dsh-mem-chip-x:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); } }
.dsh-mem-range-row { display: flex; align-items: center; gap: 12px; }
.dsh-mem-range { flex: 1 1 auto; accent-color: var(--dsw-alias-brand-primary); cursor: pointer; }
.dsh-mem-range-num { width: 84px; flex: none; }
.dsh-mem-range-num .dsh-mem-field { padding: 0; }
.dsh-mem-range-num .dsh-mem-label { display: none; }
.dsh-mem-stack { display: flex; flex-direction: column; gap: 14px; min-width: 0; }
.dsh-mem-section-card {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 16px 18px;
  border: 0.5px solid var(--dsw-alias-settings-card-stroke);
  border-radius: var(--dsw-radius-xl);
  background: var(--dsw-alias-settings-card-fill);
  min-width: 0;
}
.dsh-mem-section-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.dsh-mem-section-title { display: flex; align-items: center; gap: 8px; margin: 0; font-size: 14px; line-height: 20px; font-weight: 600; }
.dsh-mem-section-sub { margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
.dsh-mem-config-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  padding: 12px 16px;
  border: 0.5px solid var(--dsw-alias-settings-card-stroke);
  border-radius: var(--dsw-radius-xl);
  background: var(--dsw-alias-settings-card-fill);
}
.dsh-mem-dropzone {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 18px 14px;
  border: 1px dashed var(--dsw-alias-border-l4);
  border-radius: var(--dsw-radius-lg);
  background: var(--dsw-alias-bg-module-platform);
  text-align: center;
  transition: border-color 140ms ease, background 140ms ease;
}
.dsh-mem-dropzone[data-dragging="true"] {
  border-color: var(--dsw-alias-brand-primary);
  background: color-mix(in srgb, var(--dsw-alias-brand-primary) 8%, transparent);
}
.dsh-mem-proposal {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 14px;
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: var(--dsw-radius-lg);
  background: var(--dsw-alias-bg-module-platform);
  cursor: pointer;
  transition: border-color 120ms ease;
}
.dsh-mem-proposal:hover { border-color: var(--dsw-alias-border-l1); }
.dsh-mem-proposal:focus-visible {
  outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: 1px;
}
.dsh-mem-proposal-title { font-size: 13.5px; line-height: 20px; font-weight: 600; overflow-wrap: anywhere; }
.dsh-mem-proposal-body {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  font-size: 12.5px;
  line-height: 18px;
  color: var(--dsw-alias-label-secondary);
  overflow-wrap: anywhere;
}
.dsh-mem-compare {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: 10px;
}
.dsh-mem-compare-pane {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
  padding: 10px 12px;
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: var(--dsw-radius-lg);
  background: var(--dsw-alias-bg-module-platform);
}
.dsh-mem-compare-label {
  font-size: 11px;
  line-height: 16px;
  font-weight: 600;
  color: var(--dsw-alias-label-tertiary);
}
.dsh-mem-diff {
  display: flex;
  flex-direction: column;
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: var(--dsw-radius-lg);
  overflow: hidden;
  background: var(--dsw-alias-bg-module-platform);
  font-size: 12.5px;
  line-height: 1.6;
}
.dsh-mem-diff-line {
  display: flex;
  gap: 8px;
  padding: 2px 10px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.dsh-mem-diff-line[data-kind="add"] {
  background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 13%, transparent);
  color: var(--dsw-alias-label-primary);
}
.dsh-mem-diff-line[data-kind="remove"] {
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent);
  color: var(--dsw-alias-label-secondary);
}
.dsh-mem-diff-sign {
  flex: none;
  width: 12px;
  user-select: none;
  color: var(--dsw-alias-label-tertiary);
}
.dsh-mem-diff-line[data-kind="add"] .dsh-mem-diff-sign { color: var(--dsw-alias-state-success-primary); font-weight: 600; }
.dsh-mem-diff-line[data-kind="remove"] .dsh-mem-diff-sign { color: var(--dsw-alias-state-error-primary); font-weight: 600; }
.dsh-mem-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 36px 16px;
  color: var(--dsw-alias-label-tertiary);
  font-size: 13px;
  line-height: 20px;
  text-align: center;
  overflow-wrap: anywhere;
}
.dsh-mem-state-title { color: var(--dsw-alias-label-secondary); font-weight: 500; }
.dsh-mem-skeleton { display: flex; flex-direction: column; gap: 10px; padding: 10px; }
.dsh-mem-skeleton-row { display: flex; flex-direction: column; gap: 7px; padding: 8px 10px; }
.dsh-mem-skeleton-bar { height: 10px; border-radius: var(--dsw-radius-xs); background: var(--dsw-alias-bg-skeleton); animation: dsh-mem-pulse 1.6s ease-in-out infinite; }
.dsh-mem-skeleton-bar[data-w="short"] { width: 38%; }
.dsh-mem-skeleton-bar[data-w="mid"] { width: 62%; }
.dsh-mem-skeleton-bar[data-w="long"] { width: 88%; }
@keyframes dsh-mem-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.45; } }
@media (prefers-reduced-motion: reduce) {
  .dsh-mem-skeleton-bar, .dsh-mem-dot[data-pulse="true"] { animation: none; }
  .dsh-mem-chevron, .dsh-mem-switch::after, .dsh-mem-meter-fill { transition: none; }
}
`

/**
 * Responsive rules for the full-width list and the focused modal. Below 768px
 * the modal fills the viewport width, the toolbar stacks, and horizontal
 * settings rows collapse cleanly.
 */
export const NARROW_MEDIA_CSS = `@media (max-width: 768px) {
  .dsh-mem-toolbar { flex-direction: column; align-items: stretch; }
  .dsh-mem-setting-row { flex-direction: column; align-items: stretch; gap: 8px; }
  .dsh-mem-setting-control { max-width: none; justify-content: flex-start; }
  .dsh-mem-form-grid { grid-template-columns: 1fr; }
  .dsh-mem-modal { width: 100%; max-height: 92vh; }
  .dsh-mem-list-full { max-height: none; }
}`

/**
 * Page-level additions: a full-width list and the modal used for memory and
 * proposal content. The overlay is a fixed semi-transparent layer so reading
 * happens in one focused panel instead of a cramped side pane.
 */
export const MODAL_CSS = `
.dsh-mem-list-full { width: 100%; min-height: 320px; max-height: 64vh; }
.dsh-mem-overlay {
  position: fixed;
  inset: 0;
  z-index: 1200;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: color-mix(in srgb, var(--dsw-alias-bg-base) 58%, transparent);
  backdrop-filter: blur(2px);
}
.dsh-mem-modal {
  display: flex;
  flex-direction: column;
  width: min(760px, 100%);
  max-height: min(86vh, 920px);
  overflow: hidden;
  border: 0.5px solid var(--dsw-alias-settings-card-stroke);
  border-radius: var(--dsw-radius-xl);
  background: var(--dsw-alias-settings-card-fill);
  box-shadow: 0 24px 60px color-mix(in srgb, var(--dsw-alias-label-primary) 24%, transparent);
}
.dsh-mem-modal-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 18px;
  border-bottom: 0.5px solid var(--dsw-alias-border-l2);
}
.dsh-mem-modal-head-main { display: flex; flex-direction: column; gap: 4px; min-width: 0; flex: 1; }
.dsh-mem-modal-head-right { display: flex; align-items: center; gap: 6px; flex: none; }
.dsh-mem-modal-title { margin: 0; font-size: 15px; line-height: 22px; font-weight: 600; overflow-wrap: anywhere; }
.dsh-mem-modal-body { padding: 16px 18px; overflow-y: auto; flex: 1 1 auto; }
.dsh-mem-modal-footer {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  justify-content: flex-end;
  padding: 12px 18px;
  border-top: 0.5px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-settings-card-fill);
}
`

/** The complete stylesheet the section injects once. */
export const MEMORY_CSS = `${BASE_CSS}\n${MODAL_CSS}\n${NARROW_MEDIA_CSS}`

/** Loading placeholder: real text for assistive tech plus a calm skeleton. */
export function MemoryLoadingState(): React.ReactElement {
  return h(
    'div',
    { className: 'dsh-mem-state', role: 'status', 'aria-live': 'polite' },
    h(
      'div',
      { className: 'dsh-mem-skeleton', 'aria-hidden': true, style: { width: '100%' } },
      [0, 1, 2].map((index) =>
        h(
          'div',
          { key: index, className: 'dsh-mem-skeleton-row' },
          h('div', { className: 'dsh-mem-skeleton-bar', 'data-w': 'mid' }),
          h('div', { className: 'dsh-mem-skeleton-bar', 'data-w': 'long' }),
        ),
      ),
    ),
    h('span', null, t('state.loading')),
  )
}

/** Props accepted by {@link MemoryEmptyState}. */
export interface MemoryEmptyStateProps {
  title?: string | undefined
  description?: string | undefined
  action?: React.ReactNode
}

/** No-records state. */
export function MemoryEmptyState(props: MemoryEmptyStateProps): React.ReactElement {
  return h(
    'div',
    { className: 'dsh-mem-state', role: 'status' },
    h('span', { className: 'dsh-mem-state-title' }, props.title ?? t('state.empty')),
    h('span', null, props.description ?? t('list.empty')),
    props.action ?? null,
  )
}

/** Props accepted by {@link MemoryErrorState}. */
export interface MemoryErrorStateProps {
  message?: string
  onRetry?: () => void
}

/** Failure state with a retry action. */
export function MemoryErrorState(props: MemoryErrorStateProps): React.ReactElement {
  return h(
    'div',
    { className: 'dsh-mem-state', role: 'alert' },
    h(
      'span',
      { className: 'dsh-mem-state-title' },
      props.message !== undefined && props.message !== '' ? props.message : t('state.error'),
    ),
    props.onRetry === undefined
      ? null
      : h(
          'button',
          { type: 'button', className: 'dsh-mem-btn', 'data-size': 'sm', onClick: props.onRetry },
          t('common.retry'),
        ),
  )
}
