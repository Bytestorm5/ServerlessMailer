import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'Helvetica Neue', 'Arial', 'sans-serif'],
        serif: ['ui-serif', 'Iowan Old Style', 'Georgia', 'Cambria', 'Times New Roman', 'serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
      },
      colors: {
        ink: {
          50: '#f6f7f8',
          100: '#eceef1',
          200: '#d5dae1',
          300: '#b0b9c6',
          400: '#8592a5',
          500: '#66748a',
          600: '#515d71',
          700: '#434c5c',
          800: '#3a414e',
          900: '#1f242c',
          950: '#14171c',
        },
      },
    },
  },
  plugins: [],
};

export default config;
