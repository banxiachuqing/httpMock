// CodeMirror 6 bootstrap
import { EditorView, keymap, lineNumbers, highlightActiveLine } from '/vendor/codemirror/view/dist/index.js';
import { EditorState } from '/vendor/codemirror/state/dist/index.js';
import { defaultKeymap, history, historyKeymap } from '/vendor/codemirror/commands/dist/index.js';
import { syntaxHighlighting, defaultHighlightStyle, bracketMatching, indentOnInput } from '/vendor/codemirror/language/dist/index.js';
import { json, jsonParseLinter } from '/vendor/codemirror/lang-json/dist/index.js';
import { linter, lintGutter } from '/vendor/codemirror/lint/dist/index.js';

const host = document.getElementById('responseEditorHost');
let view = null;

export function mountEditor({ initialValue = '', onChange } = {}) {
  if (view) return view;
  const updateListener = EditorView.updateListener.of((u) => {
    if (u.docChanged) onChange?.(u.state.doc.toString());
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
        '.cm-gutters': { backgroundColor: 'transparent', borderRight: '1px solid #262a32', color: '#5a5d64' },
        '.cm-activeLineGutter': { backgroundColor: 'transparent', color: '#e8e6e0' },
        '.cm-activeLine': { backgroundColor: 'rgba(107,213,255,0.04)' },
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
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: text },
  });
}
