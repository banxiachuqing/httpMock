// CodeMirror 6 bootstrap
import { EditorView, keymap, lineNumbers, highlightActiveLine } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { syntaxHighlighting, defaultHighlightStyle, bracketMatching, indentOnInput } from '@codemirror/language';
import { json, jsonParseLinter } from '@codemirror/lang-json';
import { linter, lintGutter } from '@codemirror/lint';

const host = document.getElementById('responseEditorHost');
let view = null;

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
      syntaxHighlighting(defaultHighlightStyle),
      json(),
      linter(jsonParseLinter(), { delay: 200 }),
      lintGutter(),
      highlightActiveLine(),
      keymap.of([...defaultKeymap, ...historyKeymap]),
      EditorView.theme({
        '&': { height: '100%', backgroundColor: 'transparent' },
        '.cm-scroller': { fontFamily: 'JetBrains Mono, ui-monospace, monospace', fontSize: '13px', lineHeight: '1.65' },
        '.cm-content': { padding: '12px 16px' },
        '.cm-gutters': { backgroundColor: 'transparent', borderRight: '1px solid #d8d8d2', color: '#8a8a82' },
        '.cm-activeLineGutter': { backgroundColor: 'transparent', color: '#1a1a1a' },
        '.cm-activeLine': { backgroundColor: 'rgba(26,111,168,0.06)' },
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
