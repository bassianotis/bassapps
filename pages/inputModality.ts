/**
 * Rule K3 (revised 2026-11-16): the focus ring is for the keyboard. Focus that moves on its own (a
 * dialog opening, the next card after Archive, the opener after a close) shows the ring only if the
 * last thing done was a key press. The page notes which on <html data-input="key|pointer">, and
 * tokens.css makes the ring transparent after a pointer, so Tab (a key press) brings it straight back.
 * The same file is in both repos (Mail: src/shared/inputModality.ts; Bassapps: pages/inputModality.ts):
 * keep them the same.
 */
type Input = 'key' | 'pointer';

/** Keys that are only held for another (or switch apps): they aren't keyboard use on their own. */
const MODIFIERS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Fn', 'OS']);
let last: Input = 'pointer';

function note(input: Input) {
    last = input;
    if (document.documentElement.dataset.input !== input) document.documentElement.dataset.input = input;
}

/** Start noting the last input (once, as the page starts). Until a key is pressed, it's the pointer. */
export function watchInput(): void {
    note('pointer');
    window.addEventListener('keydown', e => { if (!MODIFIERS.has(e.key)) note('key'); }, true);
    window.addEventListener('pointerdown', () => note('pointer'), true);
}

/** The last thing done was a key press: focus that just moved may show the keyboard's look. */
export const lastInputWasKey = () => last === 'key';
