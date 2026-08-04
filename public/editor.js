// CodeMirror 6 bootstrap
import { EditorView, keymap, lineNumbers, highlightActiveLine } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { syntaxHighlighting, HighlightStyle, bracketMatching, indentOnInput } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';
import { json, jsonParseLinter } from '@codemirror/lang-json';
import { linter, lintGutter } from '@codemirror/lint';

const host = document.getElementById('responseEditorHost');
let view = null;

// 暗色 JSON 语法高亮（配合 Cinematic Dark Glass 主题；defaultHighlightStyle 是浅色配色）
const darkHighlight = HighlightStyle.define([
  { tag: t.bool, color: '#F5B84C' },
  { tag: t.null, color: '#F87171', fontStyle: 'italic' },
  { tag: t.number, color: '#F5B84C' },
  { tag: t.string, color: '#4ADE80' },
  { tag: t.propertyName, color: '#5E6AD2' },
  { tag: t.punctuation, color: '#5A5F6A' },
]);

/**
 * @param {{ initialValue?: string, onChange?: (text: string) => void, onSelectionChange?: (state: any) => void }} opts
 */
export function mountEditor({ initialValue = '', onChange, onSelectionChange } = {}) {
  if (view) return view;
  const updateListener = EditorView.updateListener.of((u) => {
    if (u.docChanged && !window.__editorProgrammatic) onChange?.(u.state.doc.toString());
    if (u.selectionSet || u.docChanged) onSelectionChange?.(u.state);
  });

  const state = EditorState.create({
    doc: initialValue,
    extensions: [
      lineNumbers(),
      history(),
      bracketMatching(),
      indentOnInput(),
      json(),
      linter(jsonParseLinter(), { delay: 200 }),
      lintGutter(),
      highlightActiveLine(),
      keymap.of([...defaultKeymap, ...historyKeymap]),
      syntaxHighlighting(darkHighlight),
      EditorView.theme({
        '&': { height: '100%', backgroundColor: 'transparent' },
        '.cm-scroller': { fontFamily: 'JetBrains Mono, ui-monospace, monospace', fontSize: '13px', lineHeight: '1.65' },
        '.cm-content': { padding: '12px 16px' },
        '.cm-gutters': { backgroundColor: 'transparent', borderRight: '1px solid rgba(255,255,255,0.08)', color: '#5A5F6A' },
        '.cm-activeLineGutter': { backgroundColor: 'transparent', color: '#8A8F98' },
        '.cm-activeLine': { backgroundColor: 'rgba(94,106,210,0.08)' },
        '.cm-diagnostic-error': { borderLeft: '3px solid #ff5c5c' },
        '.cm-diagnostic-warning': { borderLeft: '3px solid #ffc857' },
      }, { dark: true }),
      updateListener,
    ],
  });

  view = new EditorView({ state, parent: host });
  return view;
}

export function getValue() {
  return view ? view.state.doc.toString() : '';
}

export function setValue(text) {
  if (!view) return;
  window.__editorProgrammatic = true;
  try {
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: text },
    });
  } finally {
    queueMicrotask(() => { window.__editorProgrammatic = false; });
  }
}

export function getEditorView() {
  return view;
}

/**
 * Read-only CodeMirror viewer for log detail body. Same lang-json + theme
 * as mountEditor, but no editing surface. Caller is responsible for
 * calling .destroy() on the returned view to free memory.
 *
 * @param {HTMLElement} parent
 * @param {string} text
 * @returns {EditorView}
 */
export function mountReadonlyEditor(parent, text) {
  const state = EditorState.create({
    doc: text,
    extensions: [
      lineNumbers(),
      syntaxHighlighting(darkHighlight),
      json(),
      EditorView.editable.of(false),
      EditorState.readOnly.of(true),
      EditorView.theme({
        '&': { backgroundColor: 'transparent' },
        '.cm-scroller': { fontFamily: 'JetBrains Mono, ui-monospace, monospace', fontSize: '12px', lineHeight: '1.6' },
        '.cm-content': { padding: '8px 12px' },
        '.cm-gutters': { backgroundColor: 'transparent', borderRight: '1px solid rgba(255,255,255,0.08)', color: '#5A5F6A' },
      }, { dark: true }),
    ],
  });
  return new EditorView({ state, parent });
}

window.mountReadonlyEditor = mountReadonlyEditor;
