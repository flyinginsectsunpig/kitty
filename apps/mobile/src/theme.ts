/** The web app's look (apps/web/src/app/globals.css and the Tailwind stone palette), for native components. */
export const colors = {
  brand50: "#fff7ed",
  brand100: "#ffedd5",
  brand500: "#f97316",
  brand600: "#ea580c",
  brand700: "#c2410c",
  owed: "#15803d",
  owes: "#b91c1c",
  bg: "#fafaf9", // stone-50
  card: "#ffffff",
  border: "#e7e5e4", // stone-200
  fieldBorder: "#d6d3d1", // stone-300
  text: "#1c1917", // stone-900
  muted: "#57534e", // stone-600
  faint: "#a8a29e", // stone-400
  errorBg: "#fef2f2",
} as const;

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const;
export const radius = { field: 12, card: 16 } as const;
export const font = { sm: 14, base: 16, lg: 18, xl: 22, title: 32 } as const;
