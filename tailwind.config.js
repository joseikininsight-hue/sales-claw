/** @type {import('tailwindcss').Config} */
// Bundle 基準 (2026-04-24): Warm Paper + Premium Precision
// Source of truth: DESIGN.md + docs/design-kit/bundle/colors_and_type.css
module.exports = {
  darkMode: 'class',
  // dashboard-server.cjs のテンプレート文字列内のクラスを scan
  content: [
    './src/dashboard-server.cjs',
    './src/ui/**/*.cjs',
  ],
  theme: {
    extend: {
      // --- Colors ---
      colors: {
        // Primary (Claw Blue)
        primary: '#2563eb',
        'primary-dim': '#1d4ed8',
        'primary-glow': 'rgba(37,99,235,.12)',

        // Text (warm neutrals)
        'text-1': '#1a1a1a',
        'text-2': '#5a5a58',
        'text-3': '#9a9a96',

        // Background (warm paper)
        'bg-deep': '#eeefeb',
        'bg-base': '#f5f5f3',
        'bg-surface': '#fafaf8',
        'bg-card': '#ffffff',
        'bg-raised': '#f0f0ee',

        // Semantic status
        success: '#059669',
        warning: '#d97706',
        error: '#dc2626',
        info: '#7c3aed',
        neutral: '#64748b',

        // Pipeline (chart/badge only)
        'pipe-target': '#6366f1',
        'pipe-form': '#94a3b8',
        'pipe-filled': '#3b82f6',
        'pipe-awaiting': '#f59e0b',
        'pipe-submitted': '#10b981',
        'pipe-error': '#ef4444',
        'pipe-excluded': '#64748b',

        // Legacy compatibility (used in some existing classes)
        'primary-c': '#1d4ed8',
        surface: '#f5f5f3',
        'surface-low': '#eeefeb',
        'surface-lowest': '#ffffff',
        'surface-container': '#f0f0ee',
        'surface-high': '#fafaf8',
        'on-surface': '#1a1a1a',
        'on-surface-v': '#5a5a58',
        'outline-v': '#d4d4d0',
        outline: '#9a9a96',
        tertiary: '#d97706',
        secondary: '#7c3aed',
      },

      // --- Typography ---
      fontFamily: {
        sans: ['Inter', '"Noto Sans JP"', 'system-ui', '-apple-system', '"Segoe UI"', 'sans-serif'],
        mono: ['"JetBrains Mono"', '"Fira Code"', 'ui-monospace', 'monospace'],
      },
      fontSize: {
        // Design token scale (Bundle 基準)
        'micro': '.58rem',
        'section-label': '.6rem',
        'stat-label': '.6rem',
        'table-header': '.6rem',
        'caption': '.68rem',
        'filter-tab': '.7rem',
        'code': '.75rem',
        'button': '.78rem',
        'filter-select': '.78rem',
        'table-body': '.8rem',
        'body': '.875rem',
        'page-title': '1.15rem',
        'stat-number': '1.6rem',
      },

      // --- Spacing (8px base, 14 tiers incl. non-standard 6/7px) ---
      spacing: {
        'sp-1': '2px',
        'sp-2': '3px',
        'sp-3': '4px',
        'sp-4': '6px',
        'sp-5': '7px',
        'sp-6': '8px',
        'sp-7': '9px',
        'sp-8': '10px',
        'sp-9': '12px',
        'sp-10': '14px',
        'sp-11': '16px',
        'sp-12': '20px',
        'sp-13': '24px',
        'sp-14': '32px',
      },

      // --- Border Radius ---
      borderRadius: {
        DEFAULT: '0',
        none: '0',
        sm: '4px',
        md: '8px',
        lg: '12px',
        xl: '20px',
        pill: '999px',
        full: '9999px',
      },

      // --- Box Shadow ---
      boxShadow: {
        'ambient': '0 1px 8px rgba(15,23,42,.08)',
        'card': '0 4px 20px rgba(15,23,42,.10)',
        'modal': '0 24px 60px rgba(15,23,42,.20)',
        'header': '0 1px 12px rgba(15,23,42,.08)',
        'cta': '0 2px 10px rgba(59,130,246,.3)',
      },

      // --- Border Color (slate-blue tint, NOT gray) ---
      borderColor: {
        subtle: 'rgba(15,23,42,.07)',
        DEFAULT: 'rgba(15,23,42,.12)',
        strong: 'rgba(15,23,42,.22)',
      },

      // --- Motion ---
      transitionDuration: {
        '150': '150ms',
        '200': '200ms',
      },
    },
  },
  plugins: [
    require('@tailwindcss/forms'),
    require('@tailwindcss/container-queries'),
  ],
};
