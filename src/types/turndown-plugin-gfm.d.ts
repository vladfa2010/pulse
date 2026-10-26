// ТЗ-191: @types/turndown-plugin-gfm в реестре нет — минимальная декларация
// публичного API плагина (по факту из node_modules/turndown-plugin-gfm).
declare module 'turndown-plugin-gfm' {
  import type TurndownService from 'turndown';
  export function tables(turndown: TurndownService): void;
  export function strikethrough(turndown: TurndownService): void;
  export function taskListItems(turndown: TurndownService): void;
}
