// Encapsulates Monaco providers for Python: completions, hovers, signature help,
// built from __builtins__.py and a lightweight per-document symbol index.

import builtinsPy from "./__builtins__.py?raw";

type ParsedBuiltins = {
  classes: Record<string, { members: Record<string, string | undefined> }>;
  functions: Record<string, { doc?: string; signatureLabel?: string; params?: string[]; returnType?: string }>;
  constants: Record<string, { doc?: string }>;
  classNames: string[];
};

function parseBuiltins(py: string): ParsedBuiltins {
  const classes: ParsedBuiltins["classes"] = {};
  const functions: ParsedBuiltins["functions"] = {};
  const constants: ParsedBuiltins["constants"] = {};

  const lines = py.split(/\r?\n/);
  let i = 0;
  let currentClass: string | null = null;
  const classDecl = /^class\s+([A-Za-z_][A-Za-z0-9_]*)\s*:/;
  const memberDecl = /^(\s{4}|\t)([A-Za-z_][A-Za-z0-9_]*)\s*:\s*[A-Za-z_][A-Za-z0-9_\[\]]*/;
  const defDecl = /^def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)\s*(?:->\s*([^:]+))?\s*:/;
  const constDecl = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*[A-Za-z_][A-Za-z0-9_]*\(/;

  function readDocString(startIndex: number, minIndent = 0): { doc?: string; next: number } {
    const linesLocal = lines;
    let j = startIndex;
    while (j < linesLocal.length && linesLocal[j].trim().length === 0) j++;
    if (j >= linesLocal.length) return { next: j };
    const raw = linesLocal[j];
    const indent = raw.length - raw.trimStart().length;
    if (indent < minIndent) return { next: j };
    const t = raw.trimStart();
    const triple = t.startsWith('"""') ? '"""' : t.startsWith("'''") ? "'''" : null;
    if (!triple) return { next: j };
    let content = t.slice(3);
    if (content.includes(triple)) {
      content = content.slice(0, content.indexOf(triple));
      return { doc: content.trim(), next: j + 1 };
    }
    j++;
    const parts: string[] = [];
    while (j < linesLocal.length) {
      const lt = linesLocal[j].trimStart();
      const endIdx = lt.indexOf(triple);
      if (endIdx !== -1) {
        parts.push(lt.slice(0, endIdx));
        j++;
        break;
      }
      parts.push(lt);
      j++;
    }
    return { doc: parts.join("\n").trim(), next: j };
  }

  while (i < lines.length) {
    const line = lines[i];
    const c = classDecl.exec(line);
    if (c) {
      currentClass = c[1];
      if (!classes[currentClass]) classes[currentClass] = { members: {} };
      i++;
      continue;
    }

    if (currentClass) {
      const m = memberDecl.exec(line);
      if (m) {
        const name = m[2];
        const { doc, next } = readDocString(i + 1, 4);
        classes[currentClass].members[name] = doc;
        i = next;
        continue;
      }
      if (line.trim().length && !/^\s/.test(line)) {
        currentClass = null;
        continue;
      }
    }

    if (!currentClass) {
      const d = defDecl.exec(line);
      if (d) {
        const name = d[1];
        const paramsRaw = (d[2] || "").trim();
        const returnType = (d[3] || "").trim();
        const params = paramsRaw.length ? paramsRaw.split(",").map((p) => p.trim()) : [];
        const signatureLabel = `${name}(${paramsRaw})${returnType ? ` -> ${returnType}` : ""}`;
        const { doc, next } = readDocString(i + 1, 0);
        functions[name] = { doc, signatureLabel, params, returnType };
        i = next;
        continue;
      }
      const k = constDecl.exec(line);
      if (k) {
        const name = k[1];
        const { doc, next } = readDocString(i + 1, 0);
        constants[name] = { doc };
        i = next;
        continue;
      }
    }
    i++;
  }

  return { classes, functions, constants, classNames: Object.keys(classes) };
}

type CoreType = "list" | "dict" | "set" | "str" | "unknown";
type SymbolIndex = {
  vars: Record<string, CoreType>;
  functions: Record<string, { params: string[]; label: string }>;
};

type MethodInfo = { name: string; label: string; params: string[]; doc?: string };

const METHOD_METADATA: Record<Exclude<CoreType, "str" | "unknown">, MethodInfo[]> = {
  list: [
    { name: "append", label: "list.append(item: Any) -> None", params: ["item: Any"], doc: "Append item to the end of the list." },
    { name: "remove", label: "list.remove(item: Any) -> None", params: ["item: Any"], doc: "Remove first occurrence of item. Raises if not present." },
    { name: "insert", label: "list.insert(index: int, item: Any) -> None", params: ["index: int", "item: Any"], doc: "Insert item at a given position." },
    { name: "pop", label: "list.pop(index: Optional[int] = None) -> Any", params: ["index: Optional[int] = None"], doc: "Remove and return item at index (default last)." },
  ],
  dict: [
    { name: "pop", label: "dict.pop(key: Any) -> Any", params: ["key: Any"], doc: "Remove specified key and return the corresponding value." },
  ],
  set: [
    { name: "add", label: "set.add(item: Any) -> None", params: ["item: Any"], doc: "Add element to the set." },
    { name: "remove", label: "set.remove(item: Any) -> None", params: ["item: Any"], doc: "Remove element from the set. Raises if not present." },
  ],
};

function buildSymbolIndex(text: string): SymbolIndex {
  const vars: SymbolIndex["vars"] = {};
  const functions: SymbolIndex["functions"] = {};

  // Functions
  {
    const re = /^def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)\s*:/gm;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const name = m[1];
      const paramsRaw = (m[2] || "").trim();
      const params = paramsRaw ? paramsRaw.split(",").map((p) => p.trim()) : [];
      functions[name] = { params, label: `${name}(${paramsRaw})` };
    }
  }

  // Type annotations
  {
    const re = /^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(list|dict|set|str)\b/gm;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      vars[m[1]] = m[2] as CoreType;
    }
  }

  // Assignments and literals
  const assignPatterns: Array<[CoreType, RegExp[]]> = [
    [
      "list",
      [
        /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*\[\s*\]\s*$/gm,
        /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*\[[^\]]*\]\s*$/gm,
        /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*list\s*\(/gm,
      ],
    ],
    [
      "dict",
      [
        /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*\{\s*\}\s*$/gm,
        /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*\{[^}]*:[^}]*\}\s*$/gm,
        /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*dict\s*\(/gm,
      ],
    ],
    ["set", [/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*set\s*\(/gm]],
    [
      "str",
      [/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*("[^"]*"|'[^']*')\s*$/gm, /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*str\s*\(/gm],
    ],
  ];
  for (const [t, regs] of assignPatterns) {
    for (const re of regs) {
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        vars[m[1]] = t;
      }
    }
  }

  return { vars, functions };
}

export function setupTFWRIntelliSense(editor: any, monaco: any) {
  // Shared state per editor instance
  const builtins = parseBuiltins(builtinsPy);
  const symbolIndexes: Map<string, SymbolIndex> = new Map();
  const indexTimers: Map<string, any> = new Map();
  const disposables: { dispose: () => void }[] = [];

  // Helper to get model key and index
  function modelKey(model: any): string {
    return model?.uri?.toString?.() || "default";
  }
  function getOrBuildIndex(model: any): SymbolIndex {
    const key = modelKey(model);
    let idx = symbolIndexes.get(key);
    if (!idx) {
      try {
        idx = buildSymbolIndex(model.getValue());
      } catch {
        idx = { vars: {}, functions: {} };
      }
      symbolIndexes.set(key, idx);
    }
    return idx;
  }

  // Auto-trigger suggestions after ClassName.
  const autoSuggest = editor.onDidChangeModelContent((e: any) => {
    if (!e.changes || e.changes.length === 0) return;
    const last = e.changes[e.changes.length - 1];
    if (last.text !== ".") return;
    const pos = editor.getPosition();
    const model = editor.getModel();
    if (!pos || !model) return;
    const lineText = model.getLineContent(pos.lineNumber) || "";
    const clsRegex = new RegExp(`\\b(${builtins.classNames.join("|")})\\.$`, "i");
    if (clsRegex.test(lineText.slice(0, pos.column))) {
      editor.trigger("items.suggest", "editor.action.triggerSuggest", {});
    }
  });
  disposables.push({ dispose: () => autoSuggest.dispose() });

  // Keep a debounced per-model index
  const model = editor.getModel();
  if (model) {
    try { symbolIndexes.set(modelKey(model), buildSymbolIndex(model.getValue())); } catch {}
    const sub = model.onDidChangeContent(() => {
      const key = modelKey(model);
      const t = indexTimers.get(key);
      if (t) clearTimeout(t);
      const nt = setTimeout(() => {
        try { symbolIndexes.set(key, buildSymbolIndex(model.getValue())); } catch {}
      }, 200);
      indexTimers.set(key, nt);
    });
    disposables.push({ dispose: () => sub.dispose() });
  }

  const modelSwitch = editor.onDidChangeModel(() => {
    const m = editor.getModel();
    if (!m) return;
    try { symbolIndexes.set(modelKey(m), buildSymbolIndex(m.getValue())); } catch {}
    const sub = m.onDidChangeContent(() => {
      const key = modelKey(m);
      const t = indexTimers.get(key);
      if (t) clearTimeout(t);
      const nt = setTimeout(() => {
        try { symbolIndexes.set(key, buildSymbolIndex(m.getValue())); } catch {}
      }, 200);
      indexTimers.set(key, nt);
    });
    disposables.push({ dispose: () => sub.dispose() });
  });
  disposables.push({ dispose: () => modelSwitch.dispose() });

  // Completion provider
  const completionDisposable = monaco.languages.registerCompletionItemProvider("python", {
    triggerCharacters: ["."],
    provideCompletionItems(model: any, position: any) {
      const word = model.getWordUntilPosition(position);
      const range = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn);
      const linePrefix: string = model
        .getValueInRange(new monaco.Range(position.lineNumber, 1, position.lineNumber, position.column))
        .trimEnd();

      const symIndex = getOrBuildIndex(model);

      // identifier. — variable methods or builtins class members
      const m = linePrefix.match(/(?:^|\W)([A-Za-z_][A-Za-z0-9_]*)\.[A-Za-z_0-9]*$/);
      if (m) {
        const id = m[1];
        const varType = (symIndex.vars && symIndex.vars[id]) || "unknown";
        if (varType === "list" || varType === "dict" || varType === "set") {
          const methods = (METHOD_METADATA as any)[varType] as MethodInfo[];
          const suggestions = methods.map((mi: MethodInfo, idx: number) => ({
            label: mi.name,
            kind: monaco.languages.CompletionItemKind.Method,
            insertText: `${mi.name}()` ,
            range,
            detail: `${varType} method`,
            documentation: mi.doc ? { value: `${mi.label}\n\n${mi.doc}` } : { value: mi.label },
            sortText: `0_${idx.toString().padStart(3, "0")}_${mi.name}`,
            preselect: idx === 0,
          }));
          return { suggestions };
        }
        const clsKey = Object.keys(builtins.classes).find((k) => k.toLowerCase() === id.toLowerCase());
        if (clsKey) {
          const members = builtins.classes[clsKey].members;
          const suggestions = Object.entries(members).map(([name, doc], idx) => ({
            label: name,
            kind: monaco.languages.CompletionItemKind.EnumMember,
            insertText: name,
            range,
            detail: `${clsKey} member`,
            documentation: doc ? { value: doc } : undefined,
            sortText: `0_${idx.toString().padStart(3, "0")}_${name}`,
            preselect: idx === 0,
          }));
          return { suggestions };
        }
      }

      // Top-level: local functions and builtins
      const localFunctionSuggestions = Object.entries(symIndex.functions || {}).map(([name, info]: [string, any], idx: number) => ({
        label: name,
        kind: monaco.languages.CompletionItemKind.Function,
        insertText: `${name}()` ,
        range,
        detail: "function (document)",
        documentation: { value: (info as any).label },
        sortText: `1_${idx.toString().padStart(3, "0")}_${name}`,
      }));
      const classSuggestions = builtins.classNames.map((name: string, idx: number) => ({
        label: name,
        kind: monaco.languages.CompletionItemKind.Class,
        insertText: name,
        range,
        detail: "class",
        sortText: `1a_${idx.toString().padStart(3, "0")}_${name}`,
      }));
      const functionSuggestions = Object
        .entries(builtins.functions as Record<string, { doc?: string }>)
        .map(([name, { doc }]: [string, { doc?: string }], idx: number) => ({
          label: name,
          kind: monaco.languages.CompletionItemKind.Function,
          insertText: `${name}()` ,
          range,
          detail: "function",
          documentation: doc ? { value: doc } : undefined,
          sortText: `2_${idx.toString().padStart(3, "0")}_${name}`,
        }));
      const constantSuggestions = Object
        .entries(builtins.constants as Record<string, { doc?: string }>)
        .map(([name, { doc }]: [string, { doc?: string }], idx: number) => ({
          label: name,
          kind: monaco.languages.CompletionItemKind.Constant,
          insertText: name,
          range,
          detail: "constant",
          documentation: doc ? { value: doc } : undefined,
          sortText: `3_${idx.toString().padStart(3, "0")}_${name}`,
        }));
      return { suggestions: [
        ...localFunctionSuggestions, ...classSuggestions, ...functionSuggestions, ...constantSuggestions,
      ] };
    },
  });
  disposables.push({ dispose: () => completionDisposable.dispose() });

  // Hover provider
  const hoverDisposable = monaco.languages.registerHoverProvider("python", {
    provideHover(model: any, position: any) {
      const lineContent: string = model.getLineContent(position.lineNumber);
      const regex = /\b([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)\b/g;
      let match: RegExpExecArray | null;
      while ((match = regex.exec(lineContent)) !== null) {
        const full = match[0];
        const cls = match[1];
        const name = match[2];
        const startColumn = match.index + 1;
        const endColumn = startColumn + full.length;
        if (position.column >= startColumn && position.column <= endColumn) {
          const clsKey = Object.keys(builtins.classes).find((k) => k.toLowerCase() === cls.toLowerCase());
          if (!clsKey) return null;
          const members = builtins.classes[clsKey].members;
          const memberKey = Object.keys(members).find((k) => k.toLowerCase() === name.toLowerCase());
          if (!memberKey) return null;
          const doc = members[memberKey];
          const range = new monaco.Range(position.lineNumber, startColumn, position.lineNumber, endColumn);
          return { range, contents: [{ value: `${clsKey}.${memberKey}` }, ...(doc ? [{ value: doc }] : [])] };
        }
      }
      const word = model.getWordAtPosition(position);
      if (word) {
        const w = word.word as string;
        const fn = Object.entries(builtins.functions).find(([k]) => k.toLowerCase() === w.toLowerCase());
        if (fn) {
          const doc = fn[1].doc;
          return { range: new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn), contents: [{ value: `${w}()` }, ...(doc ? [{ value: doc }] : [])] };
        }
        const kc = Object.entries(builtins.constants).find(([k]) => k.toLowerCase() === w.toLowerCase());
        if (kc) {
          const doc = kc[1].doc;
          return { range: new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn), contents: [{ value: w }, ...(doc ? [{ value: doc }] : [])] };
        }
      }
      return null;
    },
  });
  disposables.push({ dispose: () => hoverDisposable.dispose() });

  // Signature help
  const signatureDisposable = monaco.languages.registerSignatureHelpProvider("python", {
    signatureHelpTriggerCharacters: ["(", ","],
    provideSignatureHelp(model: any, position: any) {
      const textBefore = model.getValueInRange(new monaco.Range(position.lineNumber, 1, position.lineNumber, position.column));
      const symIndex = getOrBuildIndex(model);

      // Method calls: var.method(
      const methodMatch = /([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)\s*\([^()]*$/.exec(textBefore);
      if (methodMatch) {
        const varName = methodMatch[1];
        const methodName = methodMatch[2];
        const varType = (symIndex.vars && symIndex.vars[varName]) || "unknown";
        if (varType === "list" || varType === "dict" || varType === "set") {
          const mi = ((METHOD_METADATA as any)[varType] as MethodInfo[]).find((m: MethodInfo) => m.name.toLowerCase() === methodName.toLowerCase());
          if (mi) {
            const openIdx = textBefore.lastIndexOf("(");
            const argsSoFar = openIdx >= 0 ? textBefore.slice(openIdx + 1) : "";
            const commaCount = (argsSoFar.match(/,/g) || []).length;
            const activeParameter = Math.min(commaCount, Math.max(0, mi.params.length - 1));
            return {
              value: {
                signatures: [{ label: mi.label, parameters: mi.params.map((p: string) => ({ label: p })), documentation: mi.doc ? { value: mi.doc } : undefined }],
                activeSignature: 0,
                activeParameter,
              },
              dispose: () => {},
            };
          }
        }
      }

      // Top-level functions: builtins or user-defined
      const fnMatch = /([A-Za-z_][A-Za-z0-9_]*)\s*\([^()]*$/.exec(textBefore);
      if (!fnMatch) return null;
      const fnName = fnMatch[1];
      const builtinFn = Object.entries(builtins.functions).find(([k]) => k.toLowerCase() === fnName.toLowerCase());
      let label = "";
      let params: string[] = [];
      let docStr: string | undefined = undefined;
      if (builtinFn) {
        const info = builtinFn[1];
        label = info.signatureLabel || `${fnName}()`;
        params = info.params || [];
        docStr = info.doc;
      } else if (symIndex.functions && symIndex.functions[fnName]) {
        const f = symIndex.functions[fnName];
        label = f.label;
        params = f.params;
      } else {
        return null;
      }
      const openIdx = textBefore.lastIndexOf("(");
      const argsSoFar = openIdx >= 0 ? textBefore.slice(openIdx + 1) : "";
      const commaCount = (argsSoFar.match(/,/g) || []).length;
      const activeParameter = Math.min(commaCount, Math.max(0, params.length - 1));
      const signatures = [{ label, parameters: params.map((p) => ({ label: p })), documentation: docStr ? { value: docStr } : undefined }];
      return { value: { signatures, activeSignature: 0, activeParameter }, dispose: () => {} };
    },
  });
  disposables.push({ dispose: () => signatureDisposable.dispose() });

  return () => {
    for (const d of disposables) {
      try { d.dispose(); } catch {}
    }
  };
}

export type { ParsedBuiltins };
