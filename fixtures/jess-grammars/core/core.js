// packages/core/src/ast/node.ts
function renderCombinator(comb) {
  return comb === " " ? " " : comb === "|" ? "|" : ` ${comb} `;
}
var AST_NODE_TYPES = /* @__PURE__ */ new Set([
  "Stylesheet",
  "Ruleset",
  "Declaration",
  "Comment",
  "SelectorList",
  "ComplexSelector",
  "RelativeSelector",
  "CompoundSelector",
  "SimpleSelector",
  "Keyword",
  "Null",
  "Color",
  "Quoted",
  "Any",
  "Url",
  "SelectorCapture",
  "Dimension",
  "Sequence",
  "List",
  "Lookup",
  "MixinDefinition",
  "MixinCall",
  "VariableDeclaration",
  "Important",
  "Operation",
  "FunctionCall",
  "Block",
  "Expression",
  "Condition",
  "IfValue",
  "AtRuleBlock",
  "AtRuleStatement",
  "Plugin",
  "UnknownAtRuleBlock",
  "Interpolation",
  "AnonymousMixin",
  "Collection",
  "NestedPropertyBlock",
  "CollectionEntry",
  "CollectionSpread",
  "Reference",
  "Range",
  "For",
  "If",
  "While",
  "StyleImport",
  "ModuleImport"
]);
function isNode(x) {
  if (typeof x !== "object" || x === null || !("type" in x) || typeof x.type !== "string") {
    return false;
  }
  return AST_NODE_TYPES.has(x.type);
}

// packages/core/src/ast/provenance.ts
var NO_SPAN = -1;
var COMMENT_TRIVIA_KINDS = ["comment", "blockComment", "lineComment"];
function isCommentTriviaKind(label) {
  return label === "comment" || label === "blockComment" || label === "lineComment";
}
function gapHasCommentKind(gap) {
  if (typeof gap.hasKind !== "function") {
    return true;
  }
  return COMMENT_TRIVIA_KINDS.some((kind) => gap.hasKind?.(kind) === true);
}
var valueBoundaryTriviaKey = /* @__PURE__ */ Symbol.for("jess.ast.value-boundary-trivia");
var generalEnclosedSourceKey = /* @__PURE__ */ Symbol.for("jess.ast.general-enclosed-source");
var generalEnclosedTemplateKey = /* @__PURE__ */ Symbol.for("jess.ast.general-enclosed-template");
var layoutStoreKey = /* @__PURE__ */ Symbol.for("jess.ast.value-layout-store");
var layoutGlobal = globalThis;
var layouts = layoutGlobal[layoutStoreKey] ??= /* @__PURE__ */ new WeakMap();
function rangeHasComment(src, start, end) {
  for (let i = start; i < end; i++) {
    const c = src.charCodeAt(i);
    if (c !== 32 && c !== 9 && c !== 10 && c !== 13 && c !== 12) {
      return true;
    }
  }
  return false;
}
function makeAstTrivia(src, start, end, hasComment = rangeHasComment(src, start, end)) {
  return { start, end, src, hasComment };
}
function createTriviaMapFromRanges(src, ranges) {
  const before = /* @__PURE__ */ new Map();
  const after = /* @__PURE__ */ new Map();
  let sortedComments;
  for (const range2 of ranges) {
    if (range2.end <= range2.start) {
      continue;
    }
    const run = makeAstTrivia(src, range2.start, range2.end);
    after.set(range2.start, run);
    before.set(range2.end, run);
  }
  return {
    lookup(offset, direction) {
      if (offset === void 0) {
        return void 0;
      }
      return direction === "before" ? before.get(offset) : after.get(offset);
    },
    entries(direction) {
      return direction === "before" ? before.entries() : after.entries();
    },
    has(offset, direction) {
      if (offset === void 0) {
        return false;
      }
      return direction === "before" ? before.has(offset) : after.has(offset);
    },
    commentRuns() {
      if (sortedComments === void 0) {
        const runs = [];
        for (const run of after.values()) {
          if (run.hasComment) {
            runs.push(run);
          }
        }
        runs.sort((a, b) => a.start - b.start);
        sortedComments = runs;
      }
      return sortedComments;
    }
  };
}
function createTriviaMapFromParseman(src, index) {
  if (index === void 0) {
    return createTriviaMapFromRanges(src, []);
  }
  const canonicalByStart = /* @__PURE__ */ new Map();
  const hasCommentKind = index.labels?.some(isCommentTriviaKind) === true;
  let sortedComments;
  const triviaForRange = (start, end, knownHasComment) => {
    if (end <= start) {
      return void 0;
    }
    let byEnd = canonicalByStart.get(start);
    if (byEnd === void 0) {
      byEnd = /* @__PURE__ */ new Map();
      canonicalByStart.set(start, byEnd);
    }
    let run = byEnd.get(end);
    if (run === void 0) {
      run = makeAstTrivia(src, start, end, knownHasComment);
      byEnd.set(end, run);
    }
    return run;
  };
  const triviaForGap = (gap) => {
    if (gap === void 0) {
      return void 0;
    }
    const start = gap.start;
    const end = gap.end;
    const labeledHasComment = hasCommentKind && typeof gap.hasKind === "function" ? gapHasCommentKind(gap) : void 0;
    return triviaForRange(start, end, labeledHasComment === true ? true : void 0);
  };
  return {
    lookup(offset, direction) {
      if (offset === void 0) {
        return void 0;
      }
      return triviaForGap(direction === "before" ? index.gapBefore(offset) : index.gapAfter(offset));
    },
    *entries(direction) {
      for (const gap of index.gaps()) {
        const run = triviaForGap(gap);
        if (run === void 0) {
          continue;
        }
        yield [
          direction === "before" ? run.end : run.start,
          run
        ];
      }
    },
    has(offset, direction) {
      if (offset === void 0) {
        return false;
      }
      return direction === "before" ? index.gapBefore(offset) !== void 0 : index.gapAfter(offset) !== void 0;
    },
    commentRuns() {
      if (sortedComments === void 0) {
        const runs = [];
        const labeledGaps = hasCommentKind && index.gapsWithKind !== void 0 ? index.gapsWithKind(COMMENT_TRIVIA_KINDS) : void 0;
        const gaps = labeledGaps ?? index.gaps();
        for (const gap of gaps) {
          if (labeledGaps === void 0 && !rangeHasComment(src, gap.start, gap.end)) {
            continue;
          }
          const run = triviaForGap(gap);
          if (run?.hasComment === true) {
            runs.push(run);
          }
        }
        runs.sort((a, b) => a.start - b.start);
        sortedComments = runs;
      }
      return sortedComments;
    }
  };
}
var createTriviaMapFromRootIndex = createTriviaMapFromParseman;
function withSourceSpan(node, span) {
  const slots = node;
  slots._s = span.start;
  slots._e = span.end;
  return node;
}
function sourceStartOf(node) {
  return node._s ?? NO_SPAN;
}
function sourceEndOf(node) {
  return node._e ?? NO_SPAN;
}
function isAuthoredGroupExpression(node) {
  const start = sourceStartOf(node);
  return start !== NO_SPAN && !Array.isArray(node.value) && start < sourceStartOf(node.value);
}
function sourceSpanOf(node) {
  const slots = node;
  const start = slots._s;
  if (start === void 0 || start === NO_SPAN) {
    return void 0;
  }
  return { start, end: slots._e ?? NO_SPAN };
}
function withTriviaMap(node, trivia) {
  node._trivia = trivia;
  return node;
}
function triviaMapOf(node) {
  return node._trivia;
}
function withFunctionScope(call, scope) {
  call._fnScope = scope;
  return call;
}
function hasAmbientFunctions(call) {
  const scope = call._fnScope;
  return scope === null || scope.ambient;
}
function withBodySpan(node, span) {
  const slots = node;
  slots._bs = span.start;
  slots._be = span.end;
  return node;
}
function bodySpanOf(node) {
  const slots = node;
  const start = slots._bs;
  if (start === void 0 || start === NO_SPAN) {
    return void 0;
  }
  return { start, end: slots._be ?? NO_SPAN };
}
function withValueLayout(value, separators) {
  let hasOnlyDefaultSpaces = true;
  for (const separator of separators) {
    if (separator !== " ") {
      hasOnlyDefaultSpaces = false;
      break;
    }
  }
  if (separators.length > 0 && hasOnlyDefaultSpaces && !hasTopLevelSlash(value)) {
    return value;
  }
  layouts.set(value, separators);
  return value;
}
function withValueBoundaryTrivia(value, separators, boundary) {
  const stored = [...separators];
  Object.defineProperty(stored, valueBoundaryTriviaKey, { value: boundary });
  layouts.set(value, stored);
  return value;
}
function hasTopLevelSlash(value) {
  const own = "parts" in value ? value.parts : void 0;
  const parts = Array.isArray(value) ? value : Array.isArray(own) ? own : null;
  if (parts === null) {
    return false;
  }
  for (const raw of parts) {
    let part = raw;
    if (typeof part === "object" && part !== null && "value" in part && !("type" in part)) {
      part = part.value;
    }
    if (typeof part === "object" && part !== null && "src" in part && typeof part.src === "string" && part.src.trim() === "/") {
      return true;
    }
  }
  return false;
}
function valueLayoutOf(value) {
  return layouts.get(value);
}
function withGeneralEnclosedSource(value, source) {
  const previous = layouts.get(value);
  const stored = [...previous ?? []];
  const boundary = previous?.[valueBoundaryTriviaKey];
  if (boundary !== void 0) {
    Object.defineProperty(stored, valueBoundaryTriviaKey, { value: boundary });
  }
  Object.defineProperty(stored, generalEnclosedSourceKey, { value: source });
  layouts.set(value, stored);
  return value;
}
function withGeneralEnclosedTemplate(value) {
  const previous = layouts.get(value);
  const stored = [...previous ?? []];
  const boundary = previous?.[valueBoundaryTriviaKey];
  if (boundary !== void 0) {
    Object.defineProperty(stored, valueBoundaryTriviaKey, { value: boundary });
  }
  Object.defineProperty(stored, generalEnclosedTemplateKey, { value: true });
  layouts.set(value, stored);
  return value;
}
function isGeneralEnclosedTemplate(value) {
  return layouts.get(value)?.[generalEnclosedTemplateKey] === true;
}
var GLUED_CONDITION_KEYWORDS = /* @__PURE__ */ new Set(["and", "or", "not"]);
function isGluedConditionKeyword(value) {
  return value.type === "FunctionCall" && GLUED_CONDITION_KEYWORDS.has(value.name.toLowerCase());
}
function withGluedKeywordSpan(value, span) {
  return isGluedConditionKeyword(value) ? withSourceSpan(value, span) : value;
}
function generalEnclosedSourceOf(value) {
  return layouts.get(value)?.[generalEnclosedSourceKey];
}
function valueBoundaryTriviaOf(value) {
  return layouts.get(value)?.[valueBoundaryTriviaKey];
}

// packages/core/src/ast/nodes.ts
var CSS_COLOR_CONSTRUCTORS = /* @__PURE__ */ new Set(["rgb", "rgba", "hsl", "hsla"]);
function isCssColorCall(node) {
  return CSS_COLOR_CONSTRUCTORS.has(node.name.toLowerCase()) && hasColorChannels(node);
}
var CSS_COLOR_FUNCTIONS = /* @__PURE__ */ new Set(["rgb", "rgba", "hsl", "hsla", "hwb", "lab", "lch", "oklab", "oklch", "color"]);
function hasColorChannels(node) {
  if (node.args.length >= 3) {
    return true;
  }
  const slot = node.args.length === 1 ? node.args[0].value : void 0;
  return Array.isArray(slot) && slot.length >= 3;
}
function isCssColorFunction(node) {
  return CSS_COLOR_FUNCTIONS.has(node.name.toLowerCase()) && hasColorChannels(node);
}
function colorAlphaSlash(node) {
  if (node.args.length !== 1) {
    return null;
  }
  const slot = node.args[0].value;
  if (!Array.isArray(slot) || slot.length < 3) {
    return null;
  }
  const last = slot[slot.length - 1];
  if (Array.isArray(last) || last.type !== "Expression" || Array.isArray(last.value) || last.value.type !== "Operation" || isAuthoredGroupExpression(last)) {
    return null;
  }
  const slash = last.value;
  return slash.operator === "/" && slash.mathOutsideParens && CSS_COLOR_FUNCTIONS.has(node.name.toLowerCase()) ? slash : null;
}
var isValueBlock = (n) => n.type === "AnonymousMixin";
var valueBlockBody = (n) => n.rules;
var PLACEHOLDER_SIGIL = "\\\\";
function simpleSelectorIsPlaceholder(simple) {
  return simple.type === "SimpleSelector" && simple.interp === null && typeof simple.text === "string" && simple.text.startsWith(PLACEHOLDER_SIGIL) && simple.text.length > PLACEHOLDER_SIGIL.length;
}
function branchTextIsPlaceholder(text) {
  for (let at = text.indexOf(PLACEHOLDER_SIGIL); at !== -1; at = text.indexOf(PLACEHOLDER_SIGIL, at + 2)) {
    if (at === 0) {
      return true;
    }
    const before = text.charCodeAt(at - 1);
    if (before === 32 || before === 62 || before === 43 || before === 126 || before === 44) {
      return true;
    }
  }
  return false;
}
var compoundCanonical = (c) => {
  if (c._canon === void 0) {
    let s = "";
    for (const sim of c.value) {
      s += simpleTokenText(sim);
    }
    c._canon = s;
  }
  return c._canon;
};
var pseudoHasInterp = (p) => {
  if (p._hasInterp === void 0) {
    let has = p.interp !== null;
    if (!has && p.args !== null) {
      for (const branch2 of p.args.selectors) {
        if (selectorBranchHasInterp(branch2)) {
          has = true;
          break;
        }
      }
    }
    p._hasInterp = has;
  }
  return p._hasInterp;
};
var simpleTokenHasInterp = (sim) => sim.type === "PseudoSelector" ? pseudoHasInterp(sim) : sim.interp !== null;
var compoundHasInterp = (c) => {
  if (c._hasInterp === void 0) {
    let has = false;
    for (const sim of c.value) {
      if (simpleTokenHasInterp(sim)) {
        has = true;
        break;
      }
    }
    c._hasInterp = has;
  }
  return c._hasInterp;
};
var textHoldsParentRef = (text) => text.charCodeAt(0) === 38;
var leafHasAmpersand = (sim) => {
  if (sim.text && textHoldsParentRef(sim.text)) {
    return true;
  }
  if (sim.interp !== null) {
    const head = sim.interp.parts[0];
    if (head !== void 0 && "lit" in head && head.lit.charCodeAt(0) === 91) {
      return false;
    }
    for (const part of sim.interp.parts) {
      if ("lit" in part && textHoldsParentRef(part.lit)) {
        return true;
      }
    }
  }
  return false;
};
var pseudoHasAmpersand = (p) => {
  if (p.args === null) {
    return leafHasAmpersand(p);
  }
  for (const branch2 of p.args.selectors) {
    if (selectorBranchHasAmpersand(branch2)) {
      return true;
    }
  }
  return false;
};
var compoundHasAmpersand = (c) => {
  for (const sim of c.value) {
    if (sim.type === "PseudoSelector" ? pseudoHasAmpersand(sim) : leafHasAmpersand(sim)) {
      return true;
    }
  }
  return false;
};
var complexCanonical = (c) => {
  if (c._canon === void 0) {
    let s = selectorTermCanonical(c.value[0]);
    for (let index = 1; index < c.value.length; index += 2) {
      const comb = c.value[index];
      const term = c.value[index + 1];
      if (typeof comb === "string" && term !== void 0 && typeof term !== "string") {
        s += renderCombinator(comb) + selectorTermCanonical(term);
      }
    }
    c._canon = s;
  }
  return c._canon;
};
var relativeCanonical = (c) => {
  if (c._canon === void 0) {
    let s = renderCombinator(c.value[0]).trimStart() + selectorTermCanonical(c.value[1]);
    for (let index = 2; index < c.value.length; index += 2) {
      const comb = c.value[index];
      const term = c.value[index + 1];
      if (typeof comb === "string" && term !== void 0 && typeof term !== "string") {
        s += renderCombinator(comb) + selectorTermCanonical(term);
      }
    }
    c._canon = s;
  }
  return c._canon;
};
var selectorBranchCanonical = (branch2) => branch2.type === "ComplexSelector" ? complexCanonical(branch2) : branch2.type === "RelativeSelector" ? relativeCanonical(branch2) : selectorTermCanonical(branch2);
var selectorBranchComponents = (branch2) => {
  if (branch2.type !== "ComplexSelector" && branch2.type !== "RelativeSelector") {
    return [selectorTermCanonical(branch2)];
  }
  const out = [];
  for (const part of branch2.value) {
    const text = typeof part === "string" ? renderCombinator(part).trim() : selectorTermCanonical(part);
    if (text !== "") {
      out.push(text);
    }
  }
  return out;
};
var pseudoArgumentText = (arg) => {
  if (arg.type !== "List") {
    return arg.src;
  }
  let text = "";
  for (const range2 of arg.value) {
    const src = isLanguageRange(range2) ? range2.src : "";
    text += text === "" ? src : `, ${src}`;
  }
  return text;
};
var isLanguageRange = (slot) => "type" in slot && (slot.type === "Keyword" || slot.type === "Quoted");
var pseudoJoin = (p, branches) => `${p.name}(${p.arg === null ? "" : `${pseudoArgumentText(p.arg)} of `}${branches.join(", ")})`;
var pseudoCanonical = (p) => {
  if (p.args !== null) {
    return pseudoJoin(p, p.args.selectors.map(selectorBranchCanonical));
  }
  return p.arg !== null ? `${p.name}(${pseudoArgumentText(p.arg)})` : p.text ?? "";
};
var simpleTokenText = (sim) => sim.type === "PseudoSelector" ? pseudoCanonical(sim) : sim.text ?? "";
var selectorTermCanonical = (term) => term.type === "CompoundSelector" ? compoundCanonical(term) : simpleTokenText(term);
var selectorTermHasAmpersand = (term) => term.type === "CompoundSelector" ? compoundHasAmpersand(term) : term.type === "PseudoSelector" ? pseudoHasAmpersand(term) : leafHasAmpersand(term);
var selectorTermHasInterp = (term) => term.type === "CompoundSelector" ? compoundHasInterp(term) : simpleTokenHasInterp(term);
var complexHasAmpersand = (c) => {
  if (c._hasAmp === void 0) {
    let has = false;
    for (const part of c.value) {
      if (typeof part !== "string" && selectorTermHasAmpersand(part)) {
        has = true;
        break;
      }
    }
    c._hasAmp = has;
  }
  return c._hasAmp;
};
var complexHasInterp = (c) => {
  if (c._hasInterp === void 0) {
    let has = false;
    for (const part of c.value) {
      if (typeof part !== "string" && selectorTermHasInterp(part)) {
        has = true;
        break;
      }
    }
    c._hasInterp = has;
  }
  return c._hasInterp;
};
var relativeHasAmpersand = (c) => {
  if (c._hasAmp === void 0) {
    let has = false;
    for (let index = 1; index < c.value.length; index += 1) {
      const part = c.value[index];
      if (typeof part !== "string" && selectorTermHasAmpersand(part)) {
        has = true;
        break;
      }
    }
    c._hasAmp = has;
  }
  return c._hasAmp;
};
var relativeHasInterp = (c) => {
  if (c._hasInterp === void 0) {
    let has = false;
    for (let index = 1; index < c.value.length; index += 1) {
      const part = c.value[index];
      if (typeof part !== "string" && selectorTermHasInterp(part)) {
        has = true;
        break;
      }
    }
    c._hasInterp = has;
  }
  return c._hasInterp;
};
var selectorBranchHasAmpersand = (branch2) => branch2.type === "ComplexSelector" ? complexHasAmpersand(branch2) : branch2.type === "RelativeSelector" ? relativeHasAmpersand(branch2) : selectorTermHasAmpersand(branch2);
var selectorBranchHasInterp = (branch2) => branch2.type === "ComplexSelector" ? complexHasInterp(branch2) : branch2.type === "RelativeSelector" ? relativeHasInterp(branch2) : selectorTermHasInterp(branch2);
var keyword = (src) => ({ type: "Keyword", src });
var NULL_NODE = { type: "Null", src: "null" };
var any = (src) => ({ type: "Any", src, _s: NO_SPAN, _e: NO_SPAN });
var url = (value) => ({ type: "Url", value, _s: NO_SPAN, _e: NO_SPAN });
var selectorCapture = (branches, components, src) => ({ type: "SelectorCapture", branches, components, src });
var color = (src) => ({ type: "Color", src });
var quoted = (src, value, quote, escaped, interp = null) => ({ type: "Quoted", src, value, quote, escaped, interp });
var isConditionOperand = (node) => node.type === "Condition" || node.type === "Block" && "type" in node.value && node.value.type === "Condition";
var isStaticQuoted = (n) => n.type === "Quoted" && n.interp === null;
var dimension = (number, unit = "", src = `${number}${unit}`) => ({ type: "Dimension", number, unit, src });
var isLiteralNode = (n) => n.type === "Keyword" || n.type === "Color" || n.type === "Dimension" || n.type === "Quoted" && n.interp === null || n.type === "Any";
var isTypedLiteral = (n) => isLiteralNode(n) && n.type !== "Any";
var spaced = (parts, separators) => {
  const node = { type: "Sequence", parts };
  return separators?.some((separator) => /[\n\r]/u.test(separator)) ? withValueLayout(node, separators) : node;
};
var list = (value, sep = ",") => ({ type: "List", value, sep });
var simpleSelector = (text) => ({ type: "SimpleSelector", text, interp: null, _s: NO_SPAN, _e: NO_SPAN });
var interpolatedSimpleSelector = (interp) => ({ type: "SimpleSelector", text: null, interp, _s: NO_SPAN, _e: NO_SPAN });
var CROSSABLE_PSEUDOS = /* @__PURE__ */ new Set([":is", ":matches"]);
var crossable = (name) => CROSSABLE_PSEUDOS.has(name.toLowerCase());
var pseudoSelector = (name, args, text = null, interp = null, arg = null) => ({ type: "PseudoSelector", text: args !== null || arg !== null ? null : text, interp, name, args, arg, crossable: crossable(name), _s: NO_SPAN, _e: NO_SPAN });
var anPlusB = (text) => ({ type: "AnPlusB", src: text.replace(/[ \t\n\r\f]+/g, "") });
var interpolation = (parts) => ({ type: "Interpolation", parts, _s: NO_SPAN, _e: NO_SPAN });
var anonymousMixin = (rules, params, extendInstructions) => {
  const extend = extendInstructions !== void 0 && extendInstructions.length > 0 ? [...extendInstructions] : void 0;
  return params === void 0 ? { type: "AnonymousMixin", rules, extendInstructions: extend, _bs: NO_SPAN, _be: NO_SPAN } : { type: "AnonymousMixin", rules, extendInstructions: extend, params, _bs: NO_SPAN, _be: NO_SPAN };
};
var classifyValueBlock = (rules, extendInstructions) => {
  return anonymousMixin(rules, void 0, extendInstructions);
};
var forNode = (iterable, rules, binding, asCall = null, extendInstructions) => ({
  type: "For",
  iterable,
  rules,
  binding,
  extendInstructions: extendInstructions !== void 0 && extendInstructions.length > 0 ? [...extendInstructions] : void 0,
  _asCall: asCall,
  _bs: NO_SPAN,
  _be: NO_SPAN
});
var ifNode = (branches, asCall = null) => ({ type: "If", branches, _asCall: asCall });
var whileNode = (guard, rules) => ({ type: "While", guard, rules });
var range = (start, end, step = null, includeStart = true, includeEnd = true) => ({ type: "Range", start, end, step, includeStart, includeEnd });
var reference = (base, steps, raw) => ({ type: "Reference", base, steps, raw, _s: NO_SPAN, _e: NO_SPAN });
var propertyReference = (name, raw = `$${name}`) => ({ type: "Lookup", scope: "scoped", kind: "prop", name, raw, _s: NO_SPAN, _e: NO_SPAN });
var compoundSelectorOf = (value) => ({ type: "CompoundSelector", value, _s: NO_SPAN, _e: NO_SPAN });
var selectorTermOf = (value) => {
  const [first, second, ...rest] = value;
  return second === void 0 ? first : compoundSelectorOf([first, second, ...rest]);
};
var compoundSelector = (first, second, ...rest) => compoundSelectorOf([simpleSelector(first), simpleSelector(second), ...rest.map(simpleSelector)]);
var complexSelector = (segments) => {
  const [head, ...tail] = segments;
  const value = [
    head.term,
    ...tail.flatMap((s) => [s.combinator ?? " ", s.term])
  ];
  return {
    type: "ComplexSelector",
    value,
    _s: NO_SPAN,
    _e: NO_SPAN
  };
};
var relativeSelector = (combinator, segments) => {
  const [head, ...tail] = segments;
  const value = [
    combinator,
    head.term,
    ...tail.flatMap((s) => [s.combinator ?? " ", s.term])
  ];
  return {
    type: "RelativeSelector",
    value,
    _s: NO_SPAN,
    _e: NO_SPAN
  };
};
var selectorBranchOf = (segments) => {
  const [first, second, ...rest] = segments;
  return second === void 0 ? first.term : complexSelector([first, second, ...rest]);
};
var selist = (...selectors) => ({ type: "SelectorList", selectors, _s: NO_SPAN, _e: NO_SPAN, _level: void 0 });
var decl = (name, value, merge = null, important2 = false, valueOnNewLine = false) => valueOnNewLine ? { type: "Declaration", name, value, merge, important: important2, valueOnNewLine: true, _s: NO_SPAN, _e: NO_SPAN } : { type: "Declaration", name, value, merge, important: important2, _s: NO_SPAN, _e: NO_SPAN };
var collectionEntry = (key, value, merge = null, important2 = false, valueOnNewLine = false) => valueOnNewLine ? { type: "CollectionEntry", key, value, merge, important: important2, valueOnNewLine: true } : { type: "CollectionEntry", key, value, merge, important: important2 };
var collectionSpread = (value) => ({ type: "CollectionSpread", value });
var collection = (entries) => ({ type: "Collection", entries });
var nestedPropertyBlock = (entries, base) => ({ type: "NestedPropertyBlock", entries, base: base ?? null });
var comment = (text) => ({ type: "Comment", text, _s: NO_SPAN, _e: NO_SPAN });
var variableReference = (name, lookup, raw) => ({ type: "Lookup", scope: lookup, kind: "var", name, raw: raw ?? (typeof name === "string" ? `@${name}` : ""), _s: NO_SPAN, _e: NO_SPAN });
var declarationReference = (raw = "$") => ({ type: "Lookup", scope: "scoped", kind: "entry", name: "", raw, _s: NO_SPAN, _e: NO_SPAN });
var parentSelectorReference = () => ({ type: "Lookup", scope: "scoped", kind: "parent", name: "", raw: "&", _s: NO_SPAN, _e: NO_SPAN });
var lookupStep = (kind, name, indexBase) => indexBase === void 0 ? { type: "LookupStep", kind, name } : { type: "LookupStep", kind, name, indexBase };
var important = (value) => ({ type: "Important", value });
var cssBaseMathOutsideParens = (operator) => operator !== "/";
var operation = (operator, left, right, inMathFunction, mathOutsideParens) => ({ type: "Operation", operator, left, right, inMathFunction, mathOutsideParens, _s: NO_SPAN, _e: NO_SPAN });
var callArg = (value, name, spread = false, sigil) => ({ value, name, spread, sigil });
var isCallArg = (a) => !Array.isArray(a) && "value" in a && !("type" in a);
var toCallArgs = (args) => {
  const out = new Array(args.length);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    out[i] = isCallArg(a) ? a : callArg(a);
  }
  return out;
};
var funcCall = (name, args = [], modern = false) => {
  const boxed = toCallArgs(args);
  const layout = valueLayoutOf(args);
  if (layout !== void 0) {
    withValueLayout(boxed, layout);
  }
  return { type: "FunctionCall", name, args: boxed, modern, _s: NO_SPAN, _e: NO_SPAN, _fnScope: null };
};
var block = (value, delimiter = "paren", escaped = false) => escaped ? { type: "Block", value, delimiter, escaped: true, _s: NO_SPAN, _e: NO_SPAN } : { type: "Block", value, delimiter, _s: NO_SPAN, _e: NO_SPAN };
var branch = (condition2, value) => ({ type: "Branch", condition: condition2, value });
var expression = (value, asCall = null, callArgument = false) => ({ type: "Expression", value, _s: NO_SPAN, _e: NO_SPAN, _asCall: asCall, _callArgument: callArgument });
var condition = (guard, src) => ({ type: "Condition", guard, src, _s: NO_SPAN, _e: NO_SPAN });
var ifValue = (branches, asCall = null, trailingSemicolon = false, name = "if") => ({ type: "IfValue", branches, _asCall: asCall, trailingSemicolon, name });
var variableDeclaration = (name, value, write) => ({ type: "VariableDeclaration", name, value, write, _s: NO_SPAN, _e: NO_SPAN });
var mixinDefinition = (name, params, rules, extendInstructions, guard) => ({ type: "MixinDefinition", name, params, rules, extendInstructions, guard, ruleMixin: void 0, _s: NO_SPAN, _e: NO_SPAN, _bs: NO_SPAN, _be: NO_SPAN });
var mixinDef = (name, params, rules, guard, extendInstructions) => mixinDefinition(name, params, rules, extendInstructions !== void 0 && extendInstructions.length > 0 ? [...extendInstructions] : void 0, guard);
var mixinCall = (name, args = [], content = null) => ({
  type: "MixinCall",
  name,
  args: toCallArgs(args),
  path: [],
  important: false,
  content,
  _s: NO_SPAN,
  _e: NO_SPAN
});
var apply = (selectors) => ({ type: "Apply", selectors });
var sel = (text) => simpleSelector(text);
var rule = (selector, rules, extendInstructions, guard) => {
  const list2 = typeof selector === "string" ? selist(sel(selector)) : selector.type === "SelectorList" ? selector : selist(selector);
  return {
    type: "Ruleset",
    selector: list2,
    rules,
    ...extendInstructions !== void 0 ? { extendInstructions } : {},
    ...guard !== void 0 ? { guard } : {},
    _s: NO_SPAN,
    _e: NO_SPAN,
    _bs: NO_SPAN,
    _be: NO_SPAN
  };
};
var importTargetSpelling = (target) => {
  const inner = target.type === "Url" ? target.value : target;
  if (inner.type === "Quoted") {
    return inner.interp === null ? inner.value : templateLiteralText(inner.interp);
  }
  if (inner.type === "Any") {
    return inner.src;
  }
  return inner.type === "Interpolation" ? templateLiteralText(inner) : "";
};
var templateLiteralText = (interp) => {
  let bytes = "";
  for (const part of interp.parts) {
    if ("lit" in part) {
      bytes += part.lit;
    }
  }
  return bytes;
};
var importOptionWords = (options) => {
  if (options === null) {
    return [];
  }
  const words = [];
  for (const option of options.value) {
    if (option !== null && typeof option === "object" && "type" in option && (option.type === "Any" || option.type === "Keyword")) {
      words.push(option.src.trim().toLowerCase());
    }
  }
  return words;
};
var CSS_TARGET = /\.css(?:[?#].*)?$/i;
var importIsCompileTime = (name, target, options = null, alias = null, spelling) => {
  const words = importOptionWords(options);
  if (words.includes("inline")) {
    return true;
  }
  if (words.includes("css") || alias !== null) {
    return false;
  }
  if (words.includes("less") || name.toLowerCase() === "@-import") {
    return true;
  }
  return !CSS_TARGET.test(spelling ?? importTargetSpelling(target));
};
var sassImportUrlIsPlainCss = (spelling) => spelling.length >= 5 && (spelling.startsWith("//") || spelling.startsWith("http://") || spelling.startsWith("https://"));
var styleImport = (name, target, fields = {}) => ({
  type: "StyleImport",
  name,
  target,
  options: fields.options ?? null,
  alias: fields.alias ?? null,
  mode: fields.mode ?? "compose",
  namespace: fields.namespace ?? null,
  forward: fields.forward ?? false,
  config: fields.config ?? null,
  _s: NO_SPAN,
  _e: NO_SPAN
});
var moduleImport = (path, mode, namespace = null, imports = [], defaultImport = null) => ({ type: "ModuleImport", path, mode, defaultImport, namespace, imports, _s: NO_SPAN, _e: NO_SPAN });
var stylesheet = (rules) => ({ type: "Stylesheet", rules, _s: NO_SPAN, _e: NO_SPAN, _trivia: void 0, _extend: void 0 });

// packages/core/src/ast/traversal.ts
function cursor(edge, parent, parentKind, index, depth) {
  return { phase: "authored", edge, parentKind, parent, index, depth };
}
function nodeParentKind(parent) {
  if (parent === null) {
    return null;
  }
  return isValueSlotArray(parent) ? "slot" : "type" in parent ? "node" : "guard";
}
function isValueSlotArray(value) {
  return Array.isArray(value);
}
function walkValueSlot(slot, hooks, edge, parent, index, depth) {
  if (isValueSlotArray(slot)) {
    const c = cursor(edge, parent, nodeParentKind(parent), index, depth);
    if (hooks.enterSlot?.(slot, c) === "skip-children") {
      hooks.leaveSlot?.(slot, c);
      return;
    }
    for (let i = 0; i < slot.length; i++) {
      walkValueSlot(slot[i], hooks, "value-slot.item", slot, i, depth + 1);
    }
    hooks.leaveSlot?.(slot, c);
    return;
  }
  walkNode(slot, hooks, edge, parent, index, depth);
}
function walkCallValue(value, hooks, edge, parent, index, depth) {
  if (isValueSlotArray(value)) {
    walkValueSlot(value, hooks, edge, parent, index, depth);
    return;
  }
  walkNode(value, hooks, edge, parent, index, depth);
}
function walkCallArg(arg, hooks, edge, parent, index, depth) {
  walkCallValue(arg.value, hooks, edge, parent, index, depth);
}
function walkParams(params, parent, hooks, depth, edgePrefix) {
  for (let i = 0; i < params.length; i++) {
    const param = params[i];
    if (param.default !== void 0) {
      walkValueSlot(param.default, hooks, `${edgePrefix}.param-default`, parent, i, depth + 1);
    }
    if (param.pattern !== void 0) {
      walkValueSlot(param.pattern, hooks, `${edgePrefix}.param-pattern`, parent, i, depth + 1);
    }
  }
}
function walkGuard(guard, hooks, edge, parent, index, depth) {
  const c = cursor(edge, parent, nodeParentKind(parent), index, depth);
  if (hooks.enterGuard?.(guard, c) === "skip-children") {
    hooks.leaveGuard?.(guard, c);
    return;
  }
  switch (guard.g) {
    case "cmp":
    case "match":
      walkValueSlot(guard.left, hooks, "guard.cmp.left", guard, 0, depth + 1);
      walkValueSlot(guard.right, hooks, "guard.cmp.right", guard, 1, depth + 1);
      break;
    case "and":
    case "or":
      walkGuard(guard.left, hooks, "guard.logical.left", guard, 0, depth + 1);
      walkGuard(guard.right, hooks, "guard.logical.right", guard, 1, depth + 1);
      break;
    case "not":
      walkGuard(guard.inner, hooks, "guard.not.inner", guard, 0, depth + 1);
      break;
    case "truth":
      walkValueSlot(guard.value, hooks, "guard.truth.value", guard, 0, depth + 1);
      break;
    case "css":
      walkValueSlot(guard.value, hooks, "guard.css.value", guard, 0, depth + 1);
      break;
    case "call":
      for (let i = 0; i < guard.args.length; i++) {
        walkValueSlot(guard.args[i], hooks, "guard.call.arg", guard, i, depth + 1);
      }
      break;
    case "default":
      break;
  }
  hooks.leaveGuard?.(guard, c);
}
function walkInterpolation(node, hooks, depth) {
  let refIndex = 0;
  for (const part of node.parts) {
    if ("ref" in part) {
      walkNode(part.ref, hooks, "value.interpolation.ref", node, refIndex, depth + 1);
      refIndex++;
    }
  }
}
function walkSelectorList(node, hooks, depth) {
  for (let i = 0; i < node.selectors.length; i++) {
    walkNode(node.selectors[i], hooks, "selector.branch", node, i, depth + 1);
  }
}
function walkComplexSelector(node, hooks, depth) {
  let visitIndex = 0;
  for (let i = 0; i < node.value.length; i++) {
    const part = node.value[i];
    if (typeof part !== "string") {
      walkNode(part, hooks, "selector.value", node, visitIndex, depth + 1);
      visitIndex++;
    }
  }
}
function walkRelativeSelector(node, hooks, depth) {
  let visitIndex = 0;
  for (let i = 1; i < node.value.length; i++) {
    const part = node.value[i];
    if (typeof part !== "string") {
      walkNode(part, hooks, "selector.value", node, visitIndex, depth + 1);
      visitIndex++;
    }
  }
}
function walkCompoundSelector(node, hooks, depth) {
  for (let i = 0; i < node.value.length; i++) {
    walkNode(node.value[i], hooks, "selector.simple", node, i, depth + 1);
  }
}
function walkSimpleSelector(node, hooks, depth) {
  if (node.interp !== null) {
    walkNode(node.interp, hooks, "selector.simple.interp", node, 0, depth + 1);
  }
}
function walkPseudoSelector(node, hooks, depth) {
  if (node.interp !== null) {
    walkNode(node.interp, hooks, "selector.pseudo.interp", node, 0, depth + 1);
  }
  if (node.args !== null) {
    walkNode(node.args, hooks, "selector.pseudo.args", node, 0, depth + 1);
  }
}
function walkDeclaration(node, hooks, depth) {
  if (typeof node.name !== "string") {
    walkNode(node.name, hooks, "declaration.name", node, 0, depth + 1);
  }
  walkValueSlot(node.value, hooks, "declaration.value", node, 0, depth + 1);
}
function walkVariableDeclaration(node, hooks, depth) {
  walkCallValue(node.value, hooks, "variable.value", node, 0, depth + 1);
}
function walkMixinCall(node, hooks, depth) {
  for (let i = 0; i < node.args.length; i++) {
    walkCallArg(node.args[i], hooks, "mixin-call.arg", node, i, depth + 1);
  }
  if (node.content !== null) {
    walkNode(node.content, hooks, "mixin-call.content", node, 0, depth + 1);
  }
}
function walkFunctionCall(node, hooks, depth) {
  for (let i = 0; i < node.args.length; i++) {
    walkValueSlot(node.args[i].value, hooks, "value.function.arg", node, i, depth + 1);
  }
}
function walkRuleset(node, hooks, depth) {
  walkNode(node.selector, hooks, "ruleset.selector", node, 0, depth + 1);
  if (node.guard !== void 0) {
    walkGuard(node.guard, hooks, "ruleset.guard", node, 0, depth + 1);
  }
  if (node.extendInstructions !== void 0) {
    for (let i = 0; i < node.extendInstructions.length; i++) {
      const instruction = node.extendInstructions[i];
      walkNode(instruction.target, hooks, "ruleset.extend.target", node, i, depth + 1);
      if (instruction.subject !== void 0) {
        walkNode(instruction.subject, hooks, "ruleset.extend.subject", node, i, depth + 1);
      }
    }
  }
  for (let i = 0; i < node.rules.length; i++) {
    walkNode(node.rules[i], hooks, "ruleset.rules", node, i, depth + 1);
  }
}
function walkMixinDef(node, hooks, depth) {
  walkParams(node.params, node, hooks, depth, "mixin");
  if (node.guard !== void 0) {
    walkGuard(node.guard, hooks, "mixin.guard", node, 0, depth + 1);
  }
  for (let i = 0; i < node.rules.length; i++) {
    walkNode(node.rules[i], hooks, "mixin.rules", node, i, depth + 1);
  }
}
function walkApply(node, hooks, depth) {
  for (let i = 0; i < node.selectors.length; i++) {
    walkNode(node.selectors[i], hooks, "apply.selector", node, i, depth + 1);
  }
}
function walkFor(node, hooks, depth) {
  walkCallValue(node.iterable, hooks, "for.iterable", node, 0, depth + 1);
  for (let i = 0; i < node.rules.length; i++) {
    walkNode(node.rules[i], hooks, "for.rules", node, i, depth + 1);
  }
}
function walkIf(node, hooks, depth) {
  for (let i = 0; i < node.branches.length; i++) {
    const branch2 = node.branches[i];
    if (branch2.guard !== null) {
      walkGuard(branch2.guard, hooks, "if.branch.guard", node, i, depth + 1);
    }
    for (let j = 0; j < branch2.rules.length; j++) {
      walkNode(branch2.rules[j], hooks, "if.branch.rules", node, j, depth + 1);
    }
  }
}
function walkWhile(node, hooks, depth) {
  walkGuard(node.guard, hooks, "while.guard", node, 0, depth + 1);
  for (let i = 0; i < node.rules.length; i++) {
    walkNode(node.rules[i], hooks, "while.rules", node, i, depth + 1);
  }
}
function walkAtRuleBlock(node, hooks, depth) {
  if (node.prelude !== null) {
    walkNode(node.prelude, hooks, "atrule.prelude", node, 0, depth + 1);
  }
  for (let i = 0; i < node.rules.length; i++) {
    walkNode(node.rules[i], hooks, "atrule.rules", node, i, depth + 1);
  }
}
function walkAtRuleStatement(node, hooks, depth) {
  if (node.prelude !== null) {
    walkNode(node.prelude, hooks, "atrule-statement.prelude", node, 0, depth + 1);
  }
}
function walkPlugin(node, hooks, depth) {
  walkNode(node.target, hooks, "plugin.target", node, 0, depth + 1);
  if (node.options !== null) {
    walkNode(node.options, hooks, "plugin.options", node, 0, depth + 1);
  }
}
function walkReference(node, hooks, depth) {
  walkNode(node.base, hooks, "value.reference.base", node, 0, depth + 1);
  for (let i = 0; i < node.steps.length; i++) {
    const step = node.steps[i];
    if (step.type === "LookupStep" && typeof step.name === "object") {
      walkNode(step.name, hooks, "value.reference.step-key", node, i, depth + 1);
    } else if (step.type === "Call") {
      for (let j = 0; j < step.args.length; j++) {
        walkCallArg(step.args[j], hooks, "value.reference.call-arg", node, j, depth + 1);
      }
    }
  }
}
function walkStyleImport(node, hooks, depth) {
  if (node.options !== null) {
    walkNode(node.options, hooks, "import.options", node, 0, depth + 1);
  }
  walkNode(node.target, hooks, "import.target", node, 0, depth + 1);
  if (node.alias !== null) {
    walkNode(node.alias, hooks, "import.alias", node, 0, depth + 1);
  }
  if (node.config !== null) {
    const bindings = node.config.bindings;
    for (let i = 0; i < bindings.length; i++) {
      walkNode(bindings[i], hooks, "import.config", node, i, depth + 1);
    }
  }
}
function walkModuleImport(node, hooks, depth) {
  walkNode(node.path, hooks, "module-import.path", node, 0, depth + 1);
}
function walkUnknownAtRuleBlock(node) {
  void node;
}
function walkNode(node, hooks, edge, parent, index, depth) {
  const c = cursor(edge, parent, nodeParentKind(parent), index, depth);
  if (hooks.enterNode?.(node, c) === "skip-children") {
    hooks.leaveNode?.(node, c);
    return;
  }
  switch (node.type) {
    case "Stylesheet":
      for (let i = 0; i < node.rules.length; i++) {
        walkNode(node.rules[i], hooks, "stylesheet.rules", node, i, depth + 1);
      }
      break;
    case "Ruleset":
      walkRuleset(node, hooks, depth);
      break;
    case "Declaration":
      walkDeclaration(node, hooks, depth);
      break;
    case "VariableDeclaration":
      walkVariableDeclaration(node, hooks, depth);
      break;
    case "MixinDefinition":
      walkMixinDef(node, hooks, depth);
      break;
    case "MixinCall":
      walkMixinCall(node, hooks, depth);
      break;
    case "Apply":
      walkApply(node, hooks, depth);
      break;
    case "For":
      walkFor(node, hooks, depth);
      break;
    case "If":
      walkIf(node, hooks, depth);
      break;
    case "While":
      walkWhile(node, hooks, depth);
      break;
    case "StyleImport":
      walkStyleImport(node, hooks, depth);
      break;
    case "ModuleImport":
      walkModuleImport(node, hooks, depth);
      break;
    case "AtRuleBlock":
      walkAtRuleBlock(node, hooks, depth);
      break;
    case "AtRuleStatement":
      walkAtRuleStatement(node, hooks, depth);
      break;
    case "Plugin":
      walkPlugin(node, hooks, depth);
      break;
    case "UnknownAtRuleBlock":
      walkUnknownAtRuleBlock(node);
      break;
    case "SelectorList":
      walkSelectorList(node, hooks, depth);
      break;
    case "ComplexSelector":
      walkComplexSelector(node, hooks, depth);
      break;
    case "RelativeSelector":
      walkRelativeSelector(node, hooks, depth);
      break;
    case "CompoundSelector":
      walkCompoundSelector(node, hooks, depth);
      break;
    case "SimpleSelector":
      walkSimpleSelector(node, hooks, depth);
      break;
    case "PseudoSelector":
      walkPseudoSelector(node, hooks, depth);
      break;
    case "Url":
      walkNode(node.value, hooks, "value.url.value", node, 0, depth + 1);
      break;
    case "Sequence":
      for (let i = 0; i < node.parts.length; i++) {
        walkNode(node.parts[i], hooks, "value.parts", node, i, depth + 1);
      }
      break;
    case "List":
      for (let i = 0; i < node.value.length; i++) {
        walkValueSlot(node.value[i], hooks, "value.list.item", node, i, depth + 1);
      }
      break;
    case "Important":
    case "Block":
    case "Expression":
      walkValueSlot(node.value, hooks, "value.value", node, 0, depth + 1);
      break;
    case "Operation":
      walkNode(node.left, hooks, "value.operation.left", node, 0, depth + 1);
      walkNode(node.right, hooks, "value.operation.right", node, 1, depth + 1);
      break;
    case "Branch":
      walkValueSlot(node.condition, hooks, "value.branch.condition", node, 0, depth + 1);
      walkValueSlot(node.value, hooks, "value.branch.value", node, 1, depth + 1);
      break;
    case "FunctionCall":
      walkFunctionCall(node, hooks, depth);
      break;
    case "Interpolation":
      walkInterpolation(node, hooks, depth);
      break;
    case "Lookup":
      if (typeof node.name === "object") {
        walkNode(node.name, hooks, "value.lookup.name", node, 0, depth + 1);
      }
      break;
    case "Condition":
      walkGuard(node.guard, hooks, "value.condition.guard", node, 0, depth + 1);
      break;
    case "IfValue":
      for (let i = 0; i < node.branches.length; i++) {
        const branch2 = node.branches[i];
        if (branch2.guard !== null) {
          walkGuard(branch2.guard, hooks, "value.if.branch.guard", node, i, depth + 1);
        }
        walkValueSlot(branch2.value, hooks, "value.if.branch.value", node, i, depth + 1);
      }
      break;
    case "Reference":
      walkReference(node, hooks, depth);
      break;
    case "Range":
      walkNode(node.start, hooks, "value.range.start", node, 0, depth + 1);
      walkNode(node.end, hooks, "value.range.end", node, 1, depth + 1);
      if (node.step !== null) {
        walkNode(node.step, hooks, "value.range.step", node, 2, depth + 1);
      }
      break;
    case "Collection":
      for (let i = 0; i < node.entries.length; i++) {
        walkNode(node.entries[i], hooks, "value.collection.entry", node, i, depth + 1);
      }
      break;
    case "NestedPropertyBlock":
      if (node.base !== null) {
        walkValueSlot(node.base, hooks, "value.nested-property.base", node, 0, depth + 1);
      }
      for (let i = 0; i < node.entries.length; i++) {
        walkNode(node.entries[i], hooks, "value.nested-property.entry", node, i, depth + 1);
      }
      break;
    case "CollectionEntry":
      walkValueSlot(node.key, hooks, "value.collection.key", node, 0, depth + 1);
      walkValueSlot(node.value, hooks, "value.collection.value", node, 1, depth + 1);
      break;
    case "CollectionSpread":
      walkValueSlot(node.value, hooks, "value.collection.spread", node, 0, depth + 1);
      break;
    case "AnonymousMixin":
      if (node.params !== void 0) {
        walkParams(node.params, node, hooks, depth, "value.anonymous-mixin");
      }
      for (let i = 0; i < node.rules.length; i++) {
        walkNode(node.rules[i], hooks, "value.anonymous-mixin.rules", node, i, depth + 1);
      }
      break;
    case "Quoted":
      if (node.interp !== null) {
        walkNode(node.interp, hooks, "value.quoted.interp", node, 0, depth + 1);
      }
      break;
    case "Keyword":
    case "Null":
    case "Color":
    case "Any":
    case "Comment":
    case "SelectorCapture":
    case "Dimension":
      break;
  }
  hooks.leaveNode?.(node, c);
}
function walkAuthoredAst(root, hooks) {
  walkNode(root, hooks, "root", null, 0, 0);
}
function walkAuthoredValue(value, hooks) {
  walkValueSlot(value, hooks, "root", null, 0, 0);
}

// packages/core/src/ast/at-rule.ts
var importStartKey = /* @__PURE__ */ Symbol.for("jess.ast.import-source-start");
var importEndKey = /* @__PURE__ */ Symbol.for("jess.ast.import-source-end");
var importTailStartKey = /* @__PURE__ */ Symbol.for("jess.ast.import-tail-start");
var diagnosticKey = /* @__PURE__ */ Symbol.for("jess.ast.scss-diagnostic");
var atRuleBlock = (name, prelude, rules, extendInstructions) => ({
  type: "AtRuleBlock",
  name,
  prelude,
  rules,
  extendInstructions: extendInstructions !== void 0 && extendInstructions.length > 0 ? [...extendInstructions] : void 0,
  _s: NO_SPAN,
  _e: NO_SPAN,
  _bs: NO_SPAN,
  _be: NO_SPAN
});
var atRuleStatement = (name, prelude) => {
  const statement = {
    type: "AtRuleStatement",
    name,
    prelude,
    _s: NO_SPAN,
    _e: NO_SPAN,
    [importStartKey]: NO_SPAN,
    [importEndKey]: NO_SPAN,
    [importTailStartKey]: NO_SPAN,
    [diagnosticKey]: false
  };
  return statement;
};
function asDiagnostic(statement) {
  statement[diagnosticKey] = true;
  return statement;
}
function isDiagnosticStatement(statement) {
  return statement[diagnosticKey] === true;
}
function withImportTailStart(statement, start) {
  statement[importTailStartKey] = start;
  return statement;
}
function withImportSourceSpan(statement, start, end) {
  statement[importStartKey] = start;
  statement[importEndKey] = end;
  return statement;
}
function importSourceStartOf(statement) {
  return statement[importStartKey] ?? NO_SPAN;
}
function importSourceEndOf(statement) {
  return statement[importEndKey] ?? NO_SPAN;
}
function importTailStartOf(statement) {
  return statement[importTailStartKey] ?? NO_SPAN;
}
var unknownAtRuleBlock = (name, prelude, rawBody) => ({ type: "UnknownAtRuleBlock", name, prelude, rawBody, _s: NO_SPAN, _e: NO_SPAN });
var plugin = (target, options = null) => ({ type: "Plugin", target, options, _s: NO_SPAN, _e: NO_SPAN });

// packages/core/src/ast/math-functions.ts
var CSS_MATH_FUNCTIONS = [
  "calc",
  /* comparison */
  "min",
  "max",
  "clamp",
  /* stepped-value */
  "round",
  "mod",
  "rem",
  /* trigonometric */
  "sin",
  "cos",
  "tan",
  "asin",
  "acos",
  "atan",
  "atan2",
  /* exponential */
  "pow",
  "sqrt",
  "hypot",
  "log",
  "exp",
  /* sign-related */
  "abs",
  "sign"
];
var CSS_MATH_FUNCTION_OPENERS = CSS_MATH_FUNCTIONS.map((name) => `${name}(`);
var MATH_FUNCTION_SET = new Set(CSS_MATH_FUNCTIONS);
function isMathFunctionName(name) {
  return MATH_FUNCTION_SET.has(name.toLowerCase());
}

// packages/core/src/ast/value-eval.ts
var sepGlue = (sep, compress = false) => {
  switch (sep) {
    case ",":
      return compress ? "," : ", ";
    case "/":
      return " / ";
    case ";":
      return compress ? ";" : "; ";
  }
};
var delimiterOpen = (delimiter) => delimiter === "paren" ? "(" : delimiter === "square" ? "[" : "{ ";
var delimiterClose = (delimiter) => delimiter === "paren" ? ")" : delimiter === "square" ? "]" : " }";

// packages/core/src/ast/grammar-helpers.ts
function isSpannedToken(value) {
  return typeof value === "object" && value !== null && "value" in value && "span" in value && typeof value.span === "object" && value.span !== null && "start" in value.span && "end" in value.span && typeof value.span.start === "number" && typeof value.span.end === "number";
}
function isToken(value) {
  return typeof value === "object" && value !== null && "value" in value && typeof value.value === "string";
}
function bodySpanFromRaw(rawChildren) {
  let start;
  let end;
  for (const child of rawChildren) {
    if (!isSpannedToken(child)) {
      continue;
    }
    if (child.value === "{" && start === void 0) {
      start = child.span.end;
    } else if (child.value === "}") {
      end = child.span.start;
    }
  }
  return start === void 0 || end === void 0 || end < start ? void 0 : { start, end };
}
function withBlockBody(node, rawChildren) {
  const span = bodySpanFromRaw(rawChildren);
  return span === void 0 ? node : withBodySpan(node, span);
}
function semanticGapText(text) {
  let out = "";
  let inGap = false;
  for (const char of text) {
    if (char === " " || char === "	" || char === "\n" || char === "\r" || char === "\f") {
      if (!inGap) {
        out += " ";
        inGap = true;
      }
    } else {
      out += char;
      inGap = false;
    }
  }
  return out;
}
function keywordOrNull(src) {
  return src === "null" ? NULL_NODE : keyword(src);
}
function isForBinding(value) {
  if (typeof value !== "object" || value === null || !("kind" in value)) {
    return false;
  }
  if (value.kind === "single") {
    return "name" in value && typeof value.name === "string";
  }
  return (value.kind === "comma" || value.kind === "bracket" || value.kind === "tuple") && "names" in value && Array.isArray(value.names) && value.names.every((name) => name === void 0 || typeof name === "string");
}
function isComplexSelector(value) {
  return typeof value === "object" && value !== null && "type" in value && value.type === "ComplexSelector" && "value" in value && Array.isArray(value.value);
}
function isRelativeSelector(value) {
  return typeof value === "object" && value !== null && "type" in value && value.type === "RelativeSelector" && "value" in value && Array.isArray(value.value);
}
function isModuleImport(value) {
  return typeof value === "object" && value !== null && "type" in value && value.type === "ModuleImport";
}
function isWrittenToken(child) {
  return isToken(child) && child.value.trim() !== "";
}
function writtenTokenBetween(children) {
  for (let index = 1; index < children.length - 1; index += 1) {
    const child = children[index];
    if (isWrittenToken(child)) {
      return child;
    }
  }
  return void 0;
}
function isSelectorListChild(child) {
  return typeof child === "object" && child !== null && "type" in child && child.type === "SelectorList";
}
function selectorStringComponents(read) {
  const branches = isSelectorListChild(read) ? read.selectors : void 0;
  if (branches === void 0 || branches.some(selectorBranchHasInterp)) {
    throw new TypeError("$selector: expected selector.");
  }
  if (branches.some(selectorBranchHasAmpersand)) {
    throw new TypeError("$selector: Parent selectors aren't allowed here.");
  }
  return branches.map(selectorBranchComponents);
}
function scannedLeaf(children) {
  const leaf = children[0];
  if (!isSpannedToken(leaf) || !isToken(leaf)) {
    throw new TypeError("A scan produced no leaf.");
  }
  return leaf;
}
function selectorCaptureOf(children, span) {
  const selector = children.find(isSelectorListChild);
  const rest = writtenTokenBetween(children);
  const branches = selector?.selectors.map(selectorBranchCanonical);
  const list2 = branches?.join(", ");
  if (selector?.selectors.some(selectorBranchHasInterp)) {
    const item = interpolatedItemIn(selector);
    return {
      start: item === void 0 ? span.start : sourceStartOf(item),
      end: item === void 0 ? span.end : sourceEndOf(item),
      written: void 0
    };
  }
  if (branches !== void 0 && rest === void 0) {
    return selectorCapture(branches, selector.selectors.map(selectorBranchComponents), `selector(${list2})`);
  }
  const open = children[0];
  const opener = isToken(open) ? open.value : "selector(";
  if (rest === void 0) {
    return { start: span.start, end: span.end, written: `${opener})` };
  }
  const text = rest.value.trimEnd();
  const start = isSpannedToken(rest) ? rest.span.start : span.start;
  const lead = list2 === void 0 ? "" : `${list2}${text.startsWith(",") ? "" : " "}`;
  return { start, end: start + text.length, written: `${opener}${lead}${text})` };
}
function recoveredInTree(root, errors) {
  if (!errors.some((error) => "recoveredValue" in error)) {
    return errors;
  }
  const seen = /* @__PURE__ */ new Set();
  const stack = [root];
  while (stack.length > 0) {
    const item = stack.pop();
    if (typeof item !== "object" || item === null || seen.has(item)) {
      continue;
    }
    seen.add(item);
    for (const value of Object.values(item)) {
      if (typeof value === "object" && value !== null) {
        stack.push(value);
      }
    }
  }
  return errors.filter((error) => !("recoveredValue" in error) || typeof error.recoveredValue === "object" && error.recoveredValue !== null && seen.has(error.recoveredValue));
}
function interpolatedItemIn(list2) {
  for (const branch2 of list2.selectors) {
    if (!selectorBranchHasInterp(branch2)) {
      continue;
    }
    const terms = branch2.type === "ComplexSelector" || branch2.type === "RelativeSelector" ? branch2.value : [branch2];
    for (const term of terms) {
      const tokens = typeof term === "string" ? [] : term.type === "CompoundSelector" ? term.value : [term];
      for (const token of tokens) {
        if (token.type === "PseudoSelector" && token.args !== null && pseudoHasInterp(token)) {
          return interpolatedItemIn(token.args) ?? (sourceStartOf(branch2) === NO_SPAN ? void 0 : branch2);
        }
      }
    }
    if (sourceStartOf(branch2) !== NO_SPAN) {
      return branch2;
    }
  }
  return void 0;
}

// packages/core/src/ast/query-feature-name.ts
function queryFeatureNameFrom(children) {
  if (children.length === 1 && !isInterpolation(children[0])) {
    return tokenText(children[0]);
  }
  const parts = [];
  for (const child of children) {
    if (!isInterpolation(child)) {
      appendInterpolationLiteral(parts, tokenText(child));
      continue;
    }
    for (const part of child.parts) {
      if ("lit" in part) {
        appendInterpolationLiteral(parts, part.lit);
      } else {
        parts.push(part);
      }
    }
  }
  return interpolation(parts);
}
function queryFeatureNameValue(name) {
  if (typeof name === "string") {
    return keyword(name);
  }
  if (isInterpolation(name)) {
    return name;
  }
  throw new TypeError("A query feature lost its name.");
}
function isInterpolatedName(head, children) {
  const next = children[1];
  return head.type === "Interpolation" && isTerminalText(next) && (tokenText(next) === ":" || queryComparisonOperators([next]).length === 1) && typeof children[2] !== "string";
}

// packages/core/src/ast/css-grammar-helpers.ts
function tokenText(child) {
  if (typeof child === "string") {
    return child;
  }
  if (typeof child === "object" && child !== null && "value" in child && typeof child.value === "string") {
    return child.value;
  }
  throw new Error("CSS AST grammar lost a required token");
}
function unknownBodyText(children) {
  let text = "";
  for (const child of children) {
    text += Array.isArray(child) ? unknownBodyText(child) : tokenText(child);
  }
  return text;
}
function functionOpenName(child) {
  const value = tokenText(child);
  return value.endsWith("(") ? value.slice(0, -1) : value;
}
function authoredText(child) {
  if (child === void 0 || child === null) {
    return "";
  }
  return Array.isArray(child) ? child.map(authoredText).join("") : tokenText(child);
}
function authoredSeparators(fields) {
  const capture = fields?.separator;
  if (capture === void 0) {
    return [];
  }
  const captures = Array.isArray(capture) ? capture : [capture];
  return captures.map((item) => authoredText(item.value));
}
function withAuthoredSeparators(value, fields, expected) {
  const separators = authoredSeparators(fields);
  return separators.length === expected ? withValueLayout(
    value,
    separators
  ) : value;
}
function isKeywordArgument(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) && !("type" in value) && "value" in value && typeof value.value === "object";
}
function splitArguments(children, from, to) {
  const segments = [[]];
  const separators = [];
  const commas = [[]];
  const branches = [false];
  let padding = "";
  let afterDelimiter = false;
  for (let index = from; index < to; index++) {
    const child = children[index];
    if (isValueSlotValue(child)) {
      const segment = segments[segments.length - 1];
      if (afterDelimiter) {
        separators[separators.length - 1] += padding;
        afterDelimiter = false;
      } else if (segment.length > 0 && !(branches[branches.length - 1] === true && segment.length === 1)) {
        commas[commas.length - 1].push(padding);
      }
      padding = "";
      segment.push(child);
    } else if (isKeywordArgument(child)) {
      throw new SyntaxError("A keyword argument cannot be part of a branch list or a `;` group.");
    } else if (isTerminalText(child)) {
      const text = tokenText(child);
      if (text === ";") {
        separators.push(padding + text);
        padding = "";
        afterDelimiter = true;
        segments.push([]);
        commas.push([]);
        branches.push(false);
      } else {
        if (text === ":" && segments[segments.length - 1].length === 1) {
          branches[branches.length - 1] = true;
        }
        padding += text;
      }
    }
  }
  if (afterDelimiter) {
    separators[separators.length - 1] += padding;
  }
  return { segments, separators, commas, branches };
}
function plainCallArguments(children) {
  const args = [];
  const commas = [];
  let padding = "";
  for (let index = 1; index < children.length - 1; index++) {
    const child = children[index];
    if (isValueSlotValue(child)) {
      if (args.length > 0) {
        commas.push(padding);
      }
      padding = "";
      args.push(child);
    } else if (isKeywordArgument(child)) {
      return void 0;
    } else if (isTerminalText(child)) {
      const text = tokenText(child);
      if (text === ";" || text === ":") {
        return void 0;
      }
      padding += text;
    }
  }
  return withLayoutWhenComplete(args, commas, Math.max(0, args.length - 1));
}
function withLayoutWhenComplete(value, separators, expected) {
  return separators.length === expected ? withValueLayout(value, separators) : value;
}
function semicolonGroupedCall(children) {
  const name = functionOpenName(children[0]);
  const plain = plainCallArguments(children);
  if (plain !== void 0) {
    return funcCall(name, plain);
  }
  const { segments, separators, commas, branches } = splitArguments(children, 1, children.length - 1);
  if (segments.length === 1) {
    const args = segments[0];
    const branchList = args.length === 2 ? withFirstBranchCondition(args[0], args[1]) : void 0;
    if (branchList !== void 0) {
      return funcCall(name, [branchList]);
    }
    return funcCall(name, withLayoutWhenComplete(args, commas[0], Math.max(0, args.length - 1)));
  }
  const groups = semicolonGroups(segments, commas, branches);
  return funcCall(name, [withLayoutWhenComplete(list(groups, ";"), separators, groups.length - 1)]);
}
function fallbackCall(children) {
  const name = functionOpenName(children[0]);
  const { segments, separators, commas, branches } = splitArguments(children, 1, children.length - 1);
  if (segments.length === 1 && branches[0] !== true) {
    return funcCall(name, segments[0]);
  }
  const groups = semicolonGroups(segments, commas, branches);
  return funcCall(name, [groups.length === 1 ? groups[0] : withLayoutWhenComplete(list(groups, ";"), separators, groups.length - 1)]);
}
function branchRest(children) {
  const { segments, separators, commas, branches } = splitArguments(children, 0, children.length);
  const groups = semicolonGroups(segments, commas, branches);
  const first = branch([], groups[0]);
  if (groups.length === 1) {
    return first;
  }
  groups[0] = first;
  return withLayoutWhenComplete(list(groups, ";"), separators, groups.length - 1);
}
function isOpenBranch(value) {
  return value !== void 0 && !isValueSlotArray2(value) && value.type === "Branch" && isValueSlotArray2(value.condition) && value.condition.length === 0;
}
function withFirstBranchCondition(condition2, rest) {
  if (isOpenBranch(rest)) {
    return branch(condition2, rest.value);
  }
  if (!isValueSlotArray2(rest) && rest.type === "List" && rest.sep === ";" && isOpenBranch(rest.value[0])) {
    const groups = [branch(condition2, rest.value[0].value), ...rest.value.slice(1)];
    const layout = valueLayoutOf(rest);
    return layout === void 0 ? list(groups, ";") : withValueLayout(list(groups, ";"), layout);
  }
  return void 0;
}
function ifTestCall(children) {
  const argument = generalEnclosedArgument(children.slice(1));
  return funcCall(functionOpenName(children[0]), argument === void 0 ? [] : [argument]);
}
function generalEnclosedArgument(children) {
  const items = [];
  let parts = [];
  let commas = 0;
  const flush = () => {
    items.push(parts.length === 1 ? parts[0] : parts.length === 0 ? [] : spaced(parts));
    parts = [];
  };
  for (const child of children) {
    if (isCommaList(child)) {
      child.value.forEach((item, index) => {
        if (index > 0) {
          commas++;
          flush();
        }
        parts.push(...slotParts(item));
      });
    } else if (isValueSlotValue(child)) {
      parts.push(...slotParts(child));
    } else if (typeof child === "string") {
      parts.push(keyword(child));
    } else if (isTerminalText(child)) {
      const text = tokenText(child);
      if (text === ",") {
        commas++;
        flush();
      } else if (/^(?:not|and|or)$/i.test(text)) {
        parts.push(keyword(text));
      } else if (text !== "(" && text !== ")") {
        parts.push(any(text));
      }
    }
  }
  if (commas === 0) {
    return parts.length === 0 ? void 0 : parts.length === 1 ? parts[0] : spaced(parts);
  }
  flush();
  return list(items, ",");
}
function supportsDeclaration(children) {
  const name = keyword(tokenText(children[0]));
  if (children.length === 1) {
    return name;
  }
  const value = children.find(isValueSlotValue);
  if (value === void 0) {
    return generalEnclosedSequence(children);
  }
  const parts = slotParts(value);
  return operation(":", name, parts.length === 1 ? parts[0] : spaced(parts), false, cssBaseMathOutsideParens(":"));
}
function isCommaList(value) {
  return isNodeType(value, "List") && "sep" in value && value.sep === ",";
}
function styleFeature(children) {
  const [name, value] = children.filter(isValue);
  return value === void 0 ? name : operation(":", name, value, false, cssBaseMathOutsideParens(":"));
}
function enclosedCall(children) {
  const content = children.find((child) => isNodeType(
    child,
    "Interpolation"
  ));
  if (content === void 0) {
    throw new TypeError("CSS general-enclosed lost its grammar-owned content.");
  }
  const head = children[0];
  return isTerminalText(head) && tokenText(head) !== "(" ? funcCall(
    functionOpenName(head),
    [content]
  ) : block(content);
}
function semicolonGroups(segments, commas, branches) {
  const commaRun = (values, layout) => {
    if (values.length === 0) {
      return [];
    }
    if (values.length === 1) {
      return values[0];
    }
    return withLayoutWhenComplete(list([...values], ","), layout, values.length - 1);
  };
  return segments.map((group, index) => branches[index] === true ? branch(group[0], commaRun(group.slice(1), commas[index])) : commaRun(group, commas[index]));
}
function parenGroupBlock(children) {
  const { segments, separators } = splitArguments(children, 1, children.length - 1);
  if (segments.length === 1) {
    return block(segments[0][0] ?? any(""));
  }
  const parts = segments.map((segment) => segment[0] ?? []);
  return block(withLayoutWhenComplete(list(parts, ";"), separators, parts.length - 1));
}
function sourceText(child) {
  if (typeof child === "object" && child !== null && "src" in child && typeof child.src === "string") {
    return child.src;
  }
  return tokenText(child);
}
var CSS_NODE_TRIVIA_STRIDE = 4;
function withTriviaGaps(children, triviaLog) {
  if (triviaLog.length === 0) {
    return children;
  }
  const gapped = [];
  let entry = 2;
  for (let index = 0; index <= children.length; index++) {
    entry = skipGapAt(triviaLog, entry, index);
    if (entry < 0) {
      gapped.push(" ");
      entry = -entry;
    }
    if (index < children.length) {
      gapped.push(children[index]);
    }
  }
  return gapped;
}
function skipGapAt(triviaLog, entry, index) {
  if (entry >= triviaLog.length || triviaLog[entry] !== index) {
    return entry;
  }
  let next = entry;
  while (next < triviaLog.length && triviaLog[next] === index) {
    next += CSS_NODE_TRIVIA_STRIDE;
  }
  return -next;
}
function textWithTriviaGaps(children, triviaLog) {
  let text = "";
  let entry = 2;
  for (let index = 0; index <= children.length; index++) {
    entry = skipGapAt(triviaLog, entry, index);
    if (entry < 0) {
      text += " ";
      entry = -entry;
    }
    if (index < children.length) {
      text += sourceText(children[index]);
    }
  }
  return text;
}
function semanticTextWithTriviaGaps(children, triviaLog) {
  return semanticGapText(textWithTriviaGaps(children, triviaLog));
}
var isBlockCommentAt = (source, at) => source.charCodeAt(at) === 47 && source.charCodeAt(at + 1) === 42;
function triviaTextAt(triviaLog, source, insertIndex) {
  return triviaRunText(triviaLog, source, triviaEntryAt(triviaLog, 0, insertIndex), insertIndex);
}
function triviaEntryAt(triviaLog, from, insertIndex) {
  let entry = from;
  while (entry < triviaLog.length && triviaLog[entry + 2] < insertIndex) {
    entry += CSS_NODE_TRIVIA_STRIDE;
  }
  return entry;
}
function triviaRunText(triviaLog, source, first, insertIndex) {
  let end = first;
  let hasBlockComment = false;
  let hasLineBreak = false;
  for (; end < triviaLog.length && triviaLog[end + 2] === insertIndex; end += CSS_NODE_TRIVIA_STRIDE) {
    if (isBlockCommentAt(source, triviaLog[end])) {
      hasBlockComment = true;
    } else if (!hasLineBreak) {
      for (let at = triviaLog[end], stop = triviaLog[end + 1]; at < stop; at++) {
        const code = source.charCodeAt(at);
        if (code === 10 || code === 13) {
          hasLineBreak = true;
          break;
        }
      }
    }
  }
  if (!hasBlockComment && !hasLineBreak) {
    return "";
  }
  let text = "";
  for (let entry = first; entry < end; entry += CSS_NODE_TRIVIA_STRIDE) {
    const start = triviaLog[entry];
    if (!hasBlockComment || isBlockCommentAt(source, start) || !source.startsWith("//", start) && (entry > first && isBlockCommentAt(source, triviaLog[entry - CSS_NODE_TRIVIA_STRIDE]) || entry + CSS_NODE_TRIVIA_STRIDE < end && isBlockCommentAt(source, triviaLog[entry + CSS_NODE_TRIVIA_STRIDE]))) {
      text += source.slice(start, triviaLog[entry + 1]);
    }
  }
  return text;
}
function commaListWithComments(children, fields, triviaLog, state, pick) {
  const values = children.filter(pick);
  if (values.length === 1) {
    return values[0];
  }
  const result = list(values, ",");
  const capture = fields?.separator;
  const captures = capture === void 0 ? [] : Array.isArray(capture) ? capture : [capture];
  const source = typeof state === "object" && state !== null && "source" in state && typeof state.source === "string" ? state.source : void 0;
  if (source === void 0 || captures.length !== values.length - 1) {
    return result;
  }
  const layout = [];
  let from = 0;
  for (const { value, span } of captures) {
    if (span === void 0) {
      return result;
    }
    let entry = from;
    while (entry < triviaLog.length && triviaLog[entry] < span.start) {
      entry += CSS_NODE_TRIVIA_STRIDE;
    }
    const last = entry - CSS_NODE_TRIVIA_STRIDE;
    const before = last >= from && triviaLog[last + 1] === span.start ? triviaRunText(triviaLog, source, triviaEntryAt(triviaLog, from, triviaLog[last + 2]), triviaLog[last + 2]) : "";
    const after = entry < triviaLog.length && triviaLog[entry] === span.end ? triviaRunText(triviaLog, source, entry, triviaLog[entry + 2]) : "";
    layout.push(before + authoredText(value) + after);
    from = entry;
  }
  return withValueLayout(result, layout);
}
function attributeSelectorFrom(children, triviaLog) {
  if (!children.some((child) => selectorTemplate(child) !== null)) {
    return simpleSelector(textWithTriviaGaps(children, triviaLog));
  }
  return interpolatedSimpleSelector(interpolationFromTemplateChildren(
    withTriviaGaps(children, triviaLog).map((part) => selectorTemplate(part) ?? { value: sourceText(part) }),
    "CSS"
  ));
}
function selectorTemplate(child) {
  if (isInterpolation(child)) {
    return child;
  }
  return isQuoted(child) && child.interp !== null ? interpolation([{ lit: child.quote }, ...child.interp.parts, { lit: child.quote }]) : null;
}
function isNodeType(value, type) {
  return typeof value === "object" && value !== null && "type" in value && value.type === type;
}
function isSimple(value) {
  return isNodeType(
    value,
    "SimpleSelector"
  );
}
function isSimpleToken(value) {
  return isNodeType(
    value,
    "SimpleSelector"
  ) || isNodeType(
    value,
    "PseudoSelector"
  );
}
var STRUCTURED_PSEUDOS = /* @__PURE__ */ new Set(["is", "where", "not", "has", "matches", "host", "host-context", "slotted"]);
function nthArgument(nth, of = null) {
  return { nth, of };
}
function anPlusBFrom(child) {
  return anPlusB(tokenText(child));
}
function isAnPlusB(value) {
  return isNodeType(
    value,
    "AnPlusB"
  );
}
function isNthArgument(value) {
  return typeof value === "object" && value !== null && "nth" in value && "of" in value;
}
function structuredPseudoFrom(head, name, arg) {
  if (isNthArgument(arg)) {
    return pseudoSelector(head, arg.of, null, null, arg.nth);
  }
  if (isList(arg) || isKeyword(arg)) {
    return pseudoSelector(head, null, null, null, arg);
  }
  if (isInterpolation(arg)) {
    return interpolatedSimpleSelector(interpolationFromTemplateChildren([{ value: `${head}(` }, arg, { value: ")" }], "CSS"));
  }
  if (isSelectorList(arg) && STRUCTURED_PSEUDOS.has(name.toLowerCase())) {
    return pseudoSelector(head, arg);
  }
  return null;
}
function requireStructuredPseudo(opener, arg) {
  const head = opener.slice(0, -1);
  const pseudo = structuredPseudoFrom(head, head.slice(head.startsWith("::") ? 2 : 1), arg);
  if (pseudo === null) {
    throw new TypeError("A structured pseudo lost its argument.");
  }
  return pseudo;
}
function languageRangeList(fields) {
  const capture = fields?.range;
  const captures = capture === void 0 ? [] : Array.isArray(capture) ? capture : [capture];
  const ranges = [];
  let interpolated = false;
  for (const { value } of captures) {
    const template2 = selectorTemplate(value);
    if (template2 !== null) {
      interpolated = true;
      ranges.push(template2);
    } else {
      ranges.push(isQuoted(value) ? value : keyword(tokenText(value)));
    }
  }
  if (!interpolated) {
    return list(ranges, ",");
  }
  const template = [];
  for (const range2 of ranges) {
    if (template.length > 0) {
      template.push({ value: ", " });
    }
    template.push(range2.type === "Interpolation" ? range2 : { value: range2.src });
  }
  return interpolationFromTemplateChildren(template, "CSS");
}
function directionKeyword(fields) {
  const capture = fields?.direction;
  if (capture === void 0 || !("value" in capture)) {
    throw new TypeError("A :dir() argument lost its direction.");
  }
  return keyword(tokenText(capture.value));
}
function isCompound(value) {
  return isNodeType(
    value,
    "CompoundSelector"
  );
}
function isSelectorTerm(value) {
  return isSimpleToken(value) || isCompound(value);
}
var selectorTermFromTokens = (tokens) => selectorTermOf([tokens[0], ...tokens.slice(1)]);
function isComplex(value) {
  return isNodeType(
    value,
    "ComplexSelector"
  );
}
function isRelative(value) {
  return isNodeType(
    value,
    "RelativeSelector"
  );
}
function isSelectorBranch(value) {
  return isSelectorTerm(value) || isComplex(value) || isRelative(value);
}
function isSelectorList(value) {
  return isNodeType(
    value,
    "SelectorList"
  );
}
function isKeyword(value) {
  return isNodeType(
    value,
    "Keyword"
  );
}
function isInterpolation(value) {
  return isNodeType(
    value,
    "Interpolation"
  );
}
function isDeclaration(value) {
  return isNodeType(
    value,
    "Declaration"
  );
}
function isRuleset(value) {
  return isNodeType(
    value,
    "Ruleset"
  );
}
function isAtRuleBlock(value) {
  return isNodeType(
    value,
    "AtRuleBlock"
  );
}
function isUnknownAtRuleBlock(value) {
  return isNodeType(
    value,
    "UnknownAtRuleBlock"
  );
}
function isValue(value) {
  if (typeof value !== "object" || value === null || !("type" in value)) {
    return false;
  }
  switch (value.type) {
    case "Keyword":
    case "Color":
    case "Dimension":
    case "Quoted":
    case "Url":
    case "FunctionCall":
    case "Block":
    case "Branch":
    case "Operation":
    case "Sequence":
    case "List":
    case "Any":
    case "Null":
    case "Lookup":
    case "Reference":
    case "Interpolation":
    case "Expression":
    case "Condition":
    case "IfValue":
    case "Important":
    case "SelectorCapture":
    case "AnonymousMixin":
      return true;
    default:
      return false;
  }
}
function isValueSlotArray2(value) {
  return Array.isArray(value);
}
function valueSlot(value) {
  if (isValueSlotArray2(value)) {
    return value;
  }
  if (!isValue(value)) {
    return value;
  }
  if (value.type === "Sequence") {
    return value.parts;
  }
  if (value.type === "Block" && isValue(value.value) && value.value.type === "Sequence") {
    return { ...value, value: value.value.parts };
  }
  return value;
}
function isValueSlotValue(value) {
  return isValueSlotArray2(value) ? value.every(isValueSlotValue) : isValue(value);
}
function isTerminalText(value) {
  return typeof value === "string" || typeof value === "object" && value !== null && "value" in value && typeof value.value === "string";
}
function queryComparisonOperators(children) {
  return children.filter(isTerminalText).map(tokenText).filter((value) => value === "<" || value === "<=" || value === "=" || value === ">=" || value === ">");
}
function chainedQueryComparison(left, children) {
  const operators = queryComparisonOperators(children);
  const values = valueChildren(children);
  if (operators.length === 0 || values.length === 0) {
    throw new Error("CSS AST query comparison requires an operator and value");
  }
  let result = operation(
    operators[0],
    left,
    values[0],
    false,
    cssBaseMathOutsideParens(operators[0])
  );
  for (let index = 1; index < operators.length; index++) {
    const right = values[index];
    if (right === void 0) {
      throw new Error("CSS AST query comparison lost its chained value");
    }
    result = operation(
      operators[index],
      result,
      right,
      false,
      cssBaseMathOutsideParens(operators[index])
    );
  }
  return result;
}
function queryValueRatio(children) {
  const values = valueChildren(children);
  const numerator = values[0];
  const denominator = values[1];
  return denominator === void 0 ? numerator : operation("/", numerator, denominator, false, cssBaseMathOutsideParens("/"));
}
function queryFeatureContents(children, span, state) {
  const head = children[0];
  if (isValue(head) && !isInterpolatedName(head, children)) {
    if (children.length === 1) {
      return withAuthoredGeneralEnclosed(withGluedKeywordSpan(head, span), span, state);
    }
    const isRange = (children.length === 3 || children.length === 5 && isValue(children[4]) && queryComparisonOperators([children[3]]).length === 1) && (typeof children[2] === "string" || isInterpolation(children[2]));
    if (!isRange) {
      return withAuthoredGeneralEnclosed(generalEnclosedSequence(children), span, state);
    }
    const operators = queryComparisonOperators(children);
    let result = operation(operators[0], head, isInterpolation(children[2]) ? children[2] : keyword(tokenText(children[2])), false, cssBaseMathOutsideParens(operators[0]));
    if (operators.length > 1) {
      const right = children[4];
      if (!isValue(right)) {
        throw new Error("CSS AST query range lost its trailing value");
      }
      result = operation(operators[1], result, right, false, cssBaseMathOutsideParens(operators[1]));
    }
    return result;
  }
  const name = isValue(head) ? head : keyword(tokenText(head));
  if (children.length === 1) {
    return name;
  }
  if (children.length === 2 && isValue(children[1])) {
    return spaced([name, children[1]]);
  }
  if (tokenText(children[1]) === ":") {
    return children.length === 3 && isValue(children[2]) ? operation(":", name, children[2], false, cssBaseMathOutsideParens(":")) : withAuthoredGeneralEnclosed(generalEnclosedSequence(children), span, state);
  }
  const isComparison = children.length === 3 && isValue(children[2]) || children.length === 5 && isValue(children[2]) && isValue(children[4]);
  return isComparison ? chainedQueryComparison(name, children.slice(1)) : withAuthoredGeneralEnclosed(generalEnclosedSequence(children), span, state);
}
function queryFeatureBlock(children, span, state) {
  rejectBareVariableOutsideValue(children, state);
  let count = 0;
  let only;
  for (const child of children) {
    if (!isTerminalText(child) || tokenText(child) !== "(" && tokenText(child) !== ")") {
      count++;
      only = child;
    }
  }
  if (count === 1 && isValue(only) && (generalEnclosedSourceOf(only) === void 0 || only.type === "Block")) {
    return block(isCommaList(only) ? generalEnclosedArgument(children) ?? [] : only);
  }
  return generalEnclosedGroup(block(generalEnclosedArgument(children) ?? []), span, state);
}
var DEFINED_CONDITION_FUNCTIONS = /* @__PURE__ */ new Set(["style", "scroll-state", "selector", "font-tech", "font-format"]);
function generalEnclosedGroup(group, span, state) {
  if (group.type === "FunctionCall" && DEFINED_CONDITION_FUNCTIONS.has(group.name.toLowerCase())) {
    return group;
  }
  const value = withGluedKeywordSpan(group, span);
  const payload = value.type === "FunctionCall" ? value.args[0]?.value : value.type === "Block" ? value.value : void 0;
  if (isInterpolation(payload) && payload.parts.some((part) => "ref" in part)) {
    return withGeneralEnclosedTemplate(value);
  }
  return withAuthoredGeneralEnclosed(value, span, state);
}
function withAuthoredGeneralEnclosed(value, span, state) {
  if (readsBinding(value)) {
    return value;
  }
  return withGeneralEnclosedSource(value, authoredSource(span, state, "A general-enclosed query group"));
}
function authoredSource(span, state, what) {
  if (typeof state !== "object" || state === null || !("source" in state) || typeof state.source !== "string") {
    throw new TypeError(`${what} needs the parse input in its parse state to keep its authored spelling.`);
  }
  return state.source.slice(span.start, span.end);
}
function readsBinding(value) {
  let reads = false;
  walkAuthoredValue(value, {
    enterNode(node) {
      if (node.type === "Lookup" || node.type === "Reference" || node.type === "Interpolation" && node.parts.some((part) => "ref" in part)) {
        reads = true;
      }
      return reads ? "skip-children" : void 0;
    }
  });
  return reads;
}
function rejectsBareVariable(state) {
  return typeof state === "object" && state !== null && "rejectBareVariable" in state && typeof state.rejectBareVariable === "function";
}
function rejectBareVariableOutsideValue(children, state) {
  if (!rejectsBareVariable(state)) {
    return;
  }
  const contents = children.find(isValue);
  if (contents?.type === "Operation" && contents.operator === ":") {
    return;
  }
  for (const child of children) {
    if (!isValue(child)) {
      continue;
    }
    walkAuthoredValue(child, {
      enterNode(node) {
        if (node.type === "Block" || node.type === "Interpolation" || node.type === "Quoted" || node.type === "Operation" && QUERY_VALUE_OPERATORS.has(node.operator)) {
          return "skip-children";
        }
        if (node.type === "Lookup" && node.kind === "var") {
          state.rejectBareVariable(sourceStartOf(node), sourceEndOf(node), node.raw.slice(1));
        }
        return void 0;
      }
    });
  }
}
var QUERY_VALUE_OPERATORS = /* @__PURE__ */ new Set([":", "<", ">", "<=", ">=", "="]);
function generalEnclosedSequence(children) {
  return generalEnclosedArgument(children) ?? spaced([]);
}
function slotParts(slot) {
  return isValueSlotArray2(slot) ? slot.flatMap((item, index) => index > 0 && valueLayoutOf(slot)?.[index - 1]?.trim() ? [any(valueLayoutOf(slot)[index - 1].trim()), ...slotParts(item)] : slotParts(item)) : [slot];
}
function queryConditionChain(children) {
  const values = [];
  for (const child of children) {
    if (isValueSlotValue(child)) {
      values.push(...slotParts(child));
    } else {
      const normalized = tokenText(child).toLowerCase();
      if (normalized === "not" || normalized === "and" || normalized === "or") {
        values.push(keyword(tokenText(child)));
      }
    }
  }
  return values.length === 1 ? values[0] : spaced(values);
}
function isImportTarget(value) {
  return isNodeType(
    value,
    "Quoted"
  ) || isNodeType(
    value,
    "Url"
  );
}
function importPrelude(target, tail) {
  const targetText = target.type === "Url" ? `url(${sourceText(target.value)})` : target.src;
  const tailText = tail === null ? "" : sourceText(tail);
  return any(tailText === "" ? targetText : `${targetText} ${tailText}`);
}
function isRulesetStatement(value) {
  return isDeclaration(value) || isDocumentStatement(value);
}
function isDocumentStatement(value) {
  return isRuleset(value) || isNodeType(
    value,
    "AtRuleStatement"
  ) || isNodeType(
    value,
    "AtRuleBlock"
  ) || isUnknownAtRuleBlock(value);
}
var selectorBranches = (children) => children.filter(isSelectorBranch);
function selectorArgumentText(value) {
  if (isSelectorList(value)) {
    return value.selectors.map(selectorBranchCanonical).join(",");
  }
  return tokenText(value);
}
function selectorCombinator(child) {
  const token = tokenText(child);
  if (token === ">" || token === "+" || token === "~" || token === "|" || token === "||") {
    return token;
  }
  return " ";
}
function cssRelativeCombinator(child) {
  const token = tokenText(child);
  if (token === ">" || token === "+") {
    return token;
  }
  return "~";
}
function complexSegments(children) {
  const segments = [];
  let combinator = " ";
  for (const child of children) {
    if (isSelectorTerm(child)) {
      segments.push(segments.length === 0 ? { term: child } : { combinator, term: child });
      combinator = " ";
      continue;
    }
    combinator = selectorCombinator(child);
  }
  return [segments[0], ...segments.slice(1)];
}
function branchSegments(branch2) {
  if (branch2.type !== "ComplexSelector" && branch2.type !== "RelativeSelector") {
    return [{ term: branch2 }];
  }
  const segments = [];
  let combinator = " ";
  const start = branch2.type === "RelativeSelector" ? 1 : 0;
  for (let index = start; index < branch2.value.length; index++) {
    const part = branch2.value[index];
    if (typeof part === "string") {
      combinator = part;
    } else {
      segments.push(segments.length === 0 ? { term: part } : { combinator, term: part });
      combinator = " ";
    }
  }
  return [segments[0], ...segments.slice(1)];
}
function valueChildren(children) {
  const values = children.filter(isValue);
  if (values.length === 0) {
    throw new Error("CSS AST value grammar lost its value child");
  }
  return values;
}
function flattenSequences(values) {
  const flattened = [];
  for (const value of values) {
    if (value.type === "Sequence") {
      flattened.push(...value.parts);
      continue;
    }
    flattened.push(value);
  }
  return flattened;
}
function firstValue(children) {
  for (let index = 0; index < children.length; index++) {
    const child = children[index];
    if (isValue(child)) {
      return child;
    }
  }
  throw new Error("CSS AST value grammar lost its value child");
}
function optionalValue(value) {
  if (value === null || value === void 0) {
    return null;
  }
  if (isValue(value)) {
    return value;
  }
  throw new Error("CSS AST grammar produced an invalid optional value.");
}
function valueSlotChildren(children) {
  const values = children.filter(isValueSlotValue);
  if (values.length === 0) {
    throw new Error("CSS AST value grammar lost its value child");
  }
  return values;
}
function isMathOperator(text) {
  return text === "+" || text === "-" || text === "*" || text === "/" || text === "%";
}
function foldOperation(children) {
  const first = children.find(isValue);
  if (first === void 0) {
    throw new Error("CSS AST math grammar requires an operand");
  }
  let result = first;
  let operator;
  for (let index = children.indexOf(first) + 1; index < children.length; index++) {
    const child = children[index];
    if (isValue(child)) {
      if (operator === void 0) {
        throw new Error("CSS AST math grammar lost an operator operand");
      }
      result = operation(
        operator,
        result,
        child,
        true,
        cssBaseMathOutsideParens(operator)
      );
      operator = void 0;
      continue;
    }
    if (child === void 0 || child === null) {
      continue;
    }
    const text = tokenText(child);
    if (isMathOperator(text)) {
      operator = text;
    }
  }
  if (operator !== void 0) {
    throw new Error("CSS AST math grammar lost an operator operand");
  }
  return result;
}
function rulesetStatements(children) {
  return children.filter(isRulesetStatement);
}
function documentStatements(children) {
  const statements = children.filter(isDocumentStatement);
  if (statements.length !== children.length) {
    throw new Error("Stylesheet has an unexpected child");
  }
  return statements;
}
function blockStatements(children) {
  return children.filter(isDocumentStatement);
}
function keyframeSelectorList(children) {
  const selectors = children.filter(isSimple);
  return selist(...selectors);
}
function isAtRuleStatement(value) {
  return isNodeType(
    value,
    "AtRuleStatement"
  );
}
function isMixinDefinition(value) {
  return isNodeType(
    value,
    "MixinDefinition"
  );
}
function isMixinCall(value) {
  return isNodeType(
    value,
    "MixinCall"
  );
}
function isStyleImport(value) {
  return isNodeType(
    value,
    "StyleImport"
  );
}
function isAnonymousMixin(value) {
  return isNodeType(
    value,
    "AnonymousMixin"
  );
}
function isReference(value) {
  return isNodeType(
    value,
    "Reference"
  );
}
function isList(value) {
  return isNodeType(
    value,
    "List"
  );
}
function isQuoted(value) {
  return isNodeType(
    value,
    "Quoted"
  );
}
function isFor(value) {
  return isNodeType(
    value,
    "For"
  );
}
function isIf(value) {
  return isNodeType(
    value,
    "If"
  );
}
function isWhile(value) {
  return isNodeType(
    value,
    "While"
  );
}
function isParam(value) {
  return typeof value === "object" && value !== null && !("type" in value) && ("name" in value || "pattern" in value || "rest" in value);
}
function isParamArray(value) {
  return Array.isArray(value) && value.every(isParam);
}
function isExtendInstruction(value) {
  return typeof value === "object" && value !== null && "target" in value && isSelectorList(value.target) && "partial" in value && typeof value.partial === "boolean";
}
function requireToken(value, dialect) {
  if (!isToken(value)) {
    throw new TypeError(`${dialect} grammar produced a non-token child.`);
  }
  return { value: value.value };
}
function requireString(value, dialect) {
  if (typeof value !== "string") {
    throw new TypeError(`${dialect} grammar produced a non-string child.`);
  }
  return value;
}
function requireForBinding(value, dialect) {
  if (!isForBinding(value)) {
    throw new TypeError(`${dialect} grammar produced an invalid for binding.`);
  }
  return value;
}
function requireInterpolation(value, dialect) {
  if (!isInterpolation(value)) {
    throw new TypeError(`${dialect} grammar produced a non-interpolation child.`);
  }
  return value;
}
function requireSelectorList(value, dialect) {
  if (!isSelectorList(value)) {
    throw new TypeError(`${dialect} grammar produced a non-selector-list child.`);
  }
  return value;
}
function isValueSlotOf(value, isOperand) {
  if (!Array.isArray(value)) {
    return isOperand(value);
  }
  for (const item of value) {
    if (!isValueSlotOf(
      item,
      isOperand
    )) {
      return false;
    }
  }
  return true;
}
function isGuardNodeOf(value, isOperand) {
  if (typeof value !== "object" || value === null || !("g" in value) || !("parens" in value) || typeof value.parens !== "number") {
    return false;
  }
  switch (value.g) {
    case "default":
      return true;
    case "truth":
    case "css":
      return "value" in value && isOperand(value.value);
    case "cmp":
    case "match":
      return "op" in value && typeof value.op === "string" && "implied" in value && typeof value.implied === "boolean" && "left" in value && isOperand(value.left) && "right" in value && isOperand(value.right);
    case "call":
      return "name" in value && typeof value.name === "string" && "args" in value && Array.isArray(value.args) && value.args.every(isOperand);
    case "not":
      return "word" in value && typeof value.word === "string" && "gluedAt" in value && typeof value.gluedAt === "number" && "inner" in value && isGuardNodeOf(
        value.inner,
        isOperand
      );
    case "and":
    case "or":
      return "word" in value && typeof value.word === "string" && "gluedAt" in value && typeof value.gluedAt === "number" && "left" in value && isGuardNodeOf(
        value.left,
        isOperand
      ) && "right" in value && isGuardNodeOf(
        value.right,
        isOperand
      );
    default:
      return false;
  }
}
function requireGuardNodeOf(value, isOperand, dialect) {
  if (!isGuardNodeOf(
    value,
    isOperand
  )) {
    throw new TypeError(`${dialect} grammar produced a non-guard child.`);
  }
  return value;
}
function appendInterpolationLiteral(parts, text) {
  const previous = parts[parts.length - 1];
  if (previous !== void 0 && "lit" in previous) {
    parts[parts.length - 1] = { lit: previous.lit + text };
  } else {
    parts.push({ lit: text });
  }
}
function interpolationFromTemplateChildren(children, dialect) {
  const parts = [];
  for (const child of children) {
    if (isInterpolation(child)) {
      for (const part of child.parts) {
        if ("lit" in part) {
          appendInterpolationLiteral(
            parts,
            part.lit
          );
        } else {
          parts.push(part);
        }
      }
    } else {
      appendInterpolationLiteral(
        parts,
        requireToken(
          child,
          dialect
        ).value
      );
    }
  }
  return interpolation(parts);
}
function appendCustomValueParts(children, parts, seen, dialect) {
  for (const child of children) {
    if (Array.isArray(child)) {
      appendCustomValueParts(
        child,
        parts,
        seen,
        dialect
      );
    } else if (isInterpolation(child)) {
      seen.interpolated = true;
      for (const part of child.parts) {
        if ("lit" in part) {
          appendInterpolationLiteral(
            parts,
            part.lit
          );
        } else {
          parts.push(part);
        }
      }
    } else {
      appendInterpolationLiteral(
        parts,
        requireToken(
          child,
          dialect
        ).value
      );
    }
  }
}
function customValueFromChildren(children, dialect) {
  const parts = [];
  const seen = { interpolated: false };
  appendCustomValueParts(
    children,
    parts,
    seen,
    dialect
  );
  if (seen.interpolated) {
    return interpolation(parts);
  }
  return any(parts.map((part) => "lit" in part ? part.lit : "").join(""));
}

// packages/core/src/error/codes.ts
function leadingSeparatorValueText(operator) {
  return operator === "/" ? {
    summary: 'A value cannot start with "/".',
    reason: "A slash separates two values, so it needs a value before it. A path is a value only inside url() or a string.",
    fix: "Write the path as url(/path) or as a string."
  } : {
    summary: `A value cannot start with "${operator}".`,
    reason: `A \`${operator}\` goes between two values, so it needs a value before it.`,
    fix: "Write the value it goes after, or remove it."
  };
}
var TEMPLATES = /* @__PURE__ */ new Map([
  // Parse/Lex
  [
    "parse/unexpected-token",
    {
      summary: "Unexpected token",
      reason: 'Token "${token}" is not valid here.',
      fix: "Check for a missing quote/comma or wrong operator."
    }
  ],
  [
    "parse/unterminated-string",
    {
      summary: "Unterminated string",
      reason: "Missing closing quote.",
      fix: 'Close the string, e.g. url("hero.jpg").'
    }
  ],
  [
    "parse/unexpected-syntax",
    {
      summary: "Unexpected syntax",
      reason: "Expected ${expected}, got ${got}.",
      fix: "Add the expected token or remove the unexpected one."
    }
  ],
  [
    "parse/syntax-error",
    {
      summary: "Syntax error",
      reason: "${message}",
      fix: "Check surrounding tokens near this location."
    }
  ],
  [
    "parse/invalid-value",
    {
      summary: "Invalid value",
      reason: "${dialect} expected a value here, but this token cannot start one.",
      fix: "Rewrite this position as a valid value or move the syntax into a statement position."
    }
  ],
  [
    "parse/dynamic-charset",
    {
      summary: "Dynamic @charset is not valid",
      reason: "Interpolation is not valid inside the CSS @charset token.",
      fix: 'Use a static declaration such as @charset "UTF-8";'
    }
  ],
  [
    "parse/unsupported-inline-javascript",
    {
      summary: "Inline JavaScript was removed in Less v5. Move it to a module loaded with @use.",
      reason: "Backtick JavaScript expressions cannot be enabled or evaluated.",
      fix: "Move it to a module loaded with @use."
    }
  ],
  [
    "parse/unsupported-bare-variable-interpolation",
    {
      summary: "Bare variable interpolation is not valid here",
      reason: "Bare @variable references are values; syntax and prelude interpolation must use @{variable}.",
      fix: "Wrap the variable name in interpolation braces, for example @{name}."
    }
  ],
  [
    "parse/unsupported-variable-name",
    {
      summary: "Unsupported Less variable name",
      reason: "Less variable names must not be numeric-leading or dash-only.",
      fix: "Rename the variable to a descriptive name and update its references."
    }
  ],
  [
    "parse/unsupported-mixin-name",
    {
      summary: "Unsupported Less mixin name",
      reason: "Dash-only Less mixin names are not supported.",
      fix: "Rename the mixin to a descriptive selector-like name, for example .mixin()."
    }
  ],
  [
    "parse/unparenthesized-mixin-guard",
    {
      summary: "Less mixin guard conditions must be parenthesized",
      reason: "Top-level Less mixin guards require each condition after when to be wrapped in parentheses.",
      fix: "Wrap the guard condition, for example: when (default())."
    }
  ],
  ["parse/leading-separator-value", leadingSeparatorValueText("/")],
  [
    "parse/arithmetic-outside-expression",
    {
      summary: "`*` multiplies only inside $( … ).",
      reason: "A .jess value computes only inside $( … ), so outside it this `*` would be written as it is, not multiplied.",
      fix: "Write the operation inside $( … ), for example $(2 * 3)."
    }
  ],
  [
    "parse/uncalled-mixin-reference",
    {
      summary: "A mixin reference is not a value",
      reason: "In a value, a mixin reference must be called or looked up; on its own it has no value.",
      fix: 'Call the mixin, for example .mixin(), or escape the text, for example ~".mixin".'
    }
  ],
  [
    "parse/important-on-mixin-reference",
    {
      summary: "A mixin reference cannot carry !important.",
      reason: "A mixin reference names a mixin without calling it, so it has no declarations for !important to mark.",
      fix: "Remove !important, or call the mixin: .mixin() !important."
    }
  ],
  [
    "parse/deprecated-if-function",
    {
      summary: "Sass's if($condition, $if-true, $if-false) is deprecated in favor of CSS if()",
      reason: 'Dart Sass deprecates its if() function (deprecation "if-function"): CSS if() (css-values-5 §8.3) takes its place, with a sass() condition for one decided when the stylesheet compiles.',
      fix: "Write if(sass($condition): $if-true; else: $if-false)."
    }
  ],
  [
    "parse/import-postlude-on-compile-time-import",
    {
      summary: "A compile-time @import cannot carry a layer or supports condition",
      reason: "A layer or supports condition on a compile-time @import is not supported.",
      fix: "Wrap the import in an explicit @media/@layer/@supports block."
    }
  ],
  [
    "parse/source-import-css-syntax",
    {
      summary: "@-import cannot carry a media, supports or layer condition without (css)",
      reason: "@-import has Less import semantics, so a CSS import condition needs the (css) option.",
      fix: "Remove the media, supports or layer condition, or add (css) to emit a CSS @import."
    }
  ],
  [
    "parse/invalid-mixin-argument",
    {
      summary: "Invalid mixin argument",
      reason: "This item cannot be an argument or parameter of a mixin in this position.",
      fix: 'Rewrite the argument as a value, or separate it with ";".'
    }
  ],
  [
    "parse/condition-keyword-case",
    {
      summary: "Less condition keyword not lowercase",
      reason: "A Less condition (a mixin guard, if() or boolean()) reads lowercase and, or and not; a CSS condition reads them in any case.",
      fix: "Write the keyword in lowercase."
    }
  ],
  [
    "parse/selector-capture-argument",
    {
      summary: "selector() takes a selector list",
      reason: "In a value, selector() captures a selector list, the argument :is() takes, and this argument is not one.",
      fix: "Write a selector list, for example selector(.a, .b > .c)."
    }
  ],
  [
    "parse/ambiguous-not",
    {
      summary: "`not` before a compared operand",
      reason: "`not` negates the condition or group right after it, so a comparison after a bare operand leaves open what it negates.",
      fix: "Group what `not` negates, for example: not (1 > 2)."
    }
  ],
  // Resolve/Import
  [
    "resolve/name-not-found",
    {
      summary: "Name not found",
      reason: 'Symbol "${symbol}" is undefined in this scope.',
      fix: 'Define "${symbol}" or import a file that provides it.'
    }
  ],
  [
    "resolve/ambiguous-member",
    {
      summary: "Ambiguous member",
      reason: 'Member "${symbol}" names both a variable and a property here, so the read has two candidates.',
      fix: 'Rename the variable or the property so that "${symbol}" names one of them.'
    }
  ],
  [
    "resolve/namespace-shadowed",
    {
      summary: "Module hidden by a local variable",
      reason: "Local `${local}` hides the module `${name}` (bound at ${at}), so this read looks in the local value.",
      fix: "Rename the local variable, or bind the module under another name with `as`."
    }
  ],
  [
    "import/circular-compose",
    {
      summary: "Circular @-compose detected",
      reason: "${chain}",
      fix: "Break the cycle (extract shared bits and compose that)."
    }
  ],
  [
    "compose/not-top-level",
    {
      summary: "@compose is only allowed at the top level of a stylesheet",
      reason: "A @compose is written inside a ruleset, at-rule, mixin, guard or loop body; a module is composed by the stylesheet, at its top level.",
      fix: "Move the @compose to the top level of the stylesheet, or use @import to bring the sheet into this block."
    }
  ],
  [
    "import/cycle",
    {
      summary: "Import cycle",
      reason: '"${specifier}" is imported with (multiple) while an enclosing import is still placing it, so each copy would import another without end.',
      fix: "Remove the (multiple) option, or the import that leads back to the sheet."
    }
  ],
  [
    "import/not-found",
    {
      summary: "Import not found",
      reason: 'Could not resolve "${specifier}" from "${from}".',
      fix: "Check the import path, extension, and configured include paths."
    }
  ],
  [
    "import/load-failed",
    {
      summary: 'Import "${specifier}" could not be loaded: ${reason}',
      reason: "Loading the stylesheet import failed: ${reason}",
      fix: "Check that the imported file can be read and parsed, or remove the import."
    }
  ],
  // Eval
  [
    "eval/bad-call-arity",
    {
      summary: "Bad call: wrong arity",
      reason: "${callee} expects ${expectedCount} args, got ${gotCount}.",
      fix: "Add/remove arguments to match the signature."
    }
  ],
  [
    "eval/type-mismatch",
    {
      summary: "Type mismatch",
      reason: "${callee} expects ${expected}, got ${got}.",
      fix: "Pass a ${expected}; convert or choose a compatible value."
    }
  ],
  [
    "eval/invalid-function",
    {
      summary: "Invalid function call",
      reason: '"${name}" could not be evaluated: ${reason}',
      fix: "Pass arguments accepted by the function, or use functionMode: 'preserve' to retain the CSS call."
    }
  ],
  [
    "eval/ambiguous-default",
    {
      summary: "Ambiguous default() mixin guard",
      reason: 'More than one default() decision can match "${callee}".',
      fix: "Make the default() guard select exactly one mixin definition."
    }
  ],
  [
    "eval/invalid-statement",
    {
      summary: "Value node is not valid as a statement",
      reason: "${what} is a value; it cannot stand on its own at the stylesheet root or in a declaration list — it was likely returned by a function/mixin, or is a call left as a plain CSS function call because no function by that name is in scope or it could not evaluate its arguments.",
      fix: "Wrap it in a declaration (property: value), import or define the function so it evaluates, or return a valid statement node (ruleset, declaration, at-rule) or raw text."
    }
  ],
  [
    "eval/module-config-rejected",
    {
      summary: "Module configuration was rejected",
      reason: "${reason}",
      fix: "Declare the variable as a configurable knob in the module, or remove it from the configuration block."
    }
  ],
  [
    "eval/property-in-root",
    {
      summary: "Properties must be inside selector blocks. They cannot be in the root",
      reason: 'The property "${what}" was evaluated at the root — most often a mixin or detached ruleset call that dropped its declarations into the top level.',
      fix: "Put the property inside a selector block (e.g. call the mixin/detached ruleset from within a ruleset)."
    }
  ],
  [
    "eval/ruleset-argument-with-rules",
    {
      summary: "A ruleset argument cannot be written out",
      reason: "A ruleset passed to a function is written out as its evaluated block, but this one holds ${what}, which has no one-line form inside a CSS value.",
      fix: "Pass a ruleset of declarations, nested rules and at-rules, or call the ruleset in statement position (`@ruleset();`)."
    }
  ],
  [
    "eval/guarded-selector-list",
    {
      summary: "Guarded selector lists are not supported",
      reason: "A when guard applies to ${count} selectors. Less guards are only allowed on a single CSS selector.",
      fix: "Split the selector list into separate guarded rulesets."
    }
  ],
  [
    "eval/ruleset-on-property",
    {
      summary: "Rulesets cannot be evaluated on a property",
      reason: 'The value of "${what}" evaluated to a detached ruleset; a detached ruleset can only be called (e.g. `@dr();` inside a block), not used as a property value.',
      fix: "Call the detached ruleset in statement position instead of assigning it to a property."
    }
  ],
  [
    "eval/uncalled-mixin-reference",
    {
      summary: "A mixin reference is not a value",
      reason: "${name} writes out a mixin reference, which is neither called nor looked up, so it has no value.",
      fix: "Call the mixin in statement position, or look up one of its members (`@ref[name]`), instead of writing the reference into a value."
    }
  ],
  [
    "eval/recursive-reference",
    {
      summary: "Recursive reference",
      reason: "${kind} ${symbol} refers to itself while it is being evaluated.",
      fix: "Break the cycle by assigning through an earlier value or a different name."
    }
  ],
  [
    "eval/loop-iteration-limit",
    {
      summary: "Loop did not terminate",
      reason: "A $while condition was still true after ${limit} iterations, so the loop was stopped rather than run forever.",
      fix: "Make the body change a value the condition reads, or rewrite the loop as a $for over a bounded range."
    }
  ],
  [
    "eval/mixin-recursion-limit",
    {
      summary: "Mixin recursion did not terminate",
      reason: "The mixin call ${name}() was still expanding itself when it reached the recursion limit (${limit} nested expansions, or the end of the call stack), so it was stopped rather than run forever.",
      fix: "Give the recursive mixin a guard that stops matching once its argument reaches its end value."
    }
  ],
  [
    "eval/invalid-unit-arithmetic",
    {
      summary: "Invalid unit arithmetic",
      reason: "${reason}",
      fix: "Use compatible units, cancel compound units before emission, or use unit() to normalize the value."
    }
  ],
  /*
   * SCSS `@debug` / `@warn` / `@error`. The authored message IS the diagnostic,
   * so the summary is the evaluated message verbatim; the reason/fix name which
   * directive spoke it. `@debug`/`@warn` report and continue (warn channel);
   * `@error` halts (thrown as an error).
   */
  [
    "eval/scss-debug",
    {
      summary: "${message}",
      reason: "Emitted by a Sass @debug directive.",
      fix: "Remove the @debug once you are done inspecting the value."
    }
  ],
  [
    "eval/scss-warn",
    {
      summary: "${message}",
      reason: "Emitted by a Sass @warn directive.",
      fix: "Address what the @warn reports, or remove the directive."
    }
  ],
  [
    "eval/scss-error",
    {
      summary: "${message}",
      reason: "Raised by a Sass @error directive.",
      fix: "Satisfy the condition the @error guards, or remove the directive."
    }
  ],
  [
    "eval/division-by-zero",
    {
      summary: "Division by zero",
      reason: "${expr} divides by zero, so there is no quotient to emit.",
      fix: "Divide by a non-zero value, or keep the slash as a separator by not dividing it (math: parens-division)."
    }
  ],
  [
    "eval/unexpressible-unit",
    {
      summary: "Unit has no CSS spelling",
      reason: "${expr} has no single CSS value: its units compose to one CSS cannot express, or + or - joins two units that do not convert.",
      fix: "Cancel the units, or drop one side's unit. An expression calc() accepts can be wrapped in calc() to keep it as authored."
    }
  ],
  [
    "eval/charset-not-utf8",
    {
      summary: "${charset} in ${file} is dropped: the output is UTF-8",
      reason: "A stylesheet declares one encoding, read from its first bytes, and Jess writes its output as UTF-8, so a @charset naming another encoding would make every non-ASCII character read wrongly.",
      fix: 'Save ${file} as UTF-8 and remove its @charset, or change it to @charset "UTF-8".'
    }
  ],
  [
    "eval/url-option-skipped",
    {
      summary: "${option} is not added to ${url}",
      reason: "${url} has an escaped body, which no URL option changes, so ${option} is not added to it.",
      fix: 'Write the URL as a quoted string, url("…"), to have ${option} added, or write it into the escaped string.'
    }
  ],
  [
    "css/glued-condition-keyword",
    {
      summary: "`${keyword}(` is read by CSS as a function, so this condition never matches — write `${keyword} (` if you meant the keyword",
      reason: 'An identifier glued to "(" is one function token (CSS Syntax 3 §4.3.4), so `${keyword}(` is an unknown function, not the `${keyword}` keyword, and a condition holding it matches nothing (Media Queries 4 §3.2). It is written as authored.',
      fix: "Write `${keyword} (`, with a space, if you meant the keyword."
    }
  ],
  [
    "css/forgiving-selector-item",
    {
      summary: "${item} is not a selector; browsers ignore it here",
      reason: "`:is()` and `:where()` take a forgiving selector list (Selectors 4 §16.1): an item that is not a complex selector (an empty item, one that opens with a combinator, or one that is not selector syntax) is dropped and the others still match. It is written as authored.",
      fix: "Remove it, or write the selector you meant."
    }
  ],
  [
    "css/legacy-ie-syntax",
    {
      summary: "Legacy IE syntax is not supported",
      reason: "`${what}` is legacy Internet Explorer syntax, which no other browser reads.",
      fix: "${fix}"
    }
  ],
  [
    "css/invalid-value-punctuation",
    {
      summary: "`${what}` is not valid in any CSS value",
      reason: "CSS reads `${what}` as a delim token, and no CSS value accepts it, so a browser drops the declaration.",
      fix: "${fix}"
    }
  ],
  [
    "css/invalid-supports-condition",
    {
      summary: "`${what}` is not a supports condition",
      reason: "`@supports` takes one condition: parenthesized features and groups and functions such as `selector()`, joined by `and` or by `or` (not both), or one of them after `not` (css-conditional-3 §6). `${what}` stands where none of them can (`selector (a)` is the identifier `selector` and a group, not the `selector()` function), so a browser ignores the whole rule.",
      fix: "Write a feature `(property: value)`, or a function with no space before its `(` (`selector(a)`); group a mix of `and` and `or` in parentheses."
    }
  ],
  [
    "eval/empty-operand",
    {
      summary: "Operation on an empty value",
      reason: "${reason}",
      fix: "Operate on a value: a function that returns nothing (false, true or an empty result) can only stand as a statement."
    }
  ],
  [
    "eval/empty-list-value",
    {
      summary: "An empty list is not a CSS value",
      reason: "${reason}",
      fix: "Write a value, or leave the declaration or argument out when the list is empty."
    }
  ],
  [
    "eval/invalid-operand",
    {
      summary: "Operation on an operand it is not defined on",
      reason: "${reason}",
      fix: 'Compute with numbers, lengths and colours, and write math the browser computes inside `calc()`. To build a string, interpolate: `"Elapsed: #{$t}"` in `.scss`, `"Elapsed: $($t)"` in `.jess`.'
    }
  ],
  [
    "eval/incomparable-operands",
    {
      summary: "Incomparable operands",
      reason: "${reason}",
      fix: "Compare values that share a ground — two numbers, two strings, or two colours — or test with = instead, which is false rather than an error when there is no ground."
    }
  ],
  [
    "eval/unit-conversion",
    {
      summary: 'Cannot convert "${value}" to a color',
      reason: "A dimension with a unit cannot be compared against a color.",
      fix: "Drop the unit, or compare compatible types."
    }
  ],
  // Extend
  [
    "extend/protected-boundary",
    {
      summary: "Extend blocked by protected boundary",
      reason: '"${target}" is defined behind a protected compose boundary.',
      fix: 'Move "${target}" to a shared file or create a local shim.'
    }
  ],
  [
    "extend/not-found",
    {
      summary: 'Extend target "${target}" not found',
      reason: 'No ruleset found matching "${target}" in accessible extend roots.',
      fix: 'Ensure "${target}" exists and is accessible from the current extend root.'
    }
  ],
  [
    "extend/not-accessible",
    {
      summary: 'Extend target "${target}" not accessible',
      reason: '"${target}" exists but is not accessible from the current extend root (blocked by at-rule or compose boundary).',
      fix: "Move the extend or the target to a shared extend root, or use a different approach."
    }
  ],
  // Plugin
  [
    "plugin/unsupported-feature",
    {
      summary: 'Plugin "${plugin}" uses ${feature}, which is not supported',
      reason: 'Plugin "${plugin}" uses ${feature}, which this compiler does not provide, so the plugin cannot be installed.',
      fix: "${replacement}"
    }
  ],
  [
    "plugin/invalid-option",
    {
      summary: "The ${plugin} option ${option} must be ${allowed}; got ${value}",
      reason: "The ${plugin} plugin has no ${option} value ${value}, so it would have to guess which mode was meant.",
      fix: "Set ${option} to ${allowed}."
    }
  ],
  // Warnings
  [
    "eval/deprecated",
    {
      summary: "Deprecated feature",
      reason: '"${what}" is deprecated.',
      fix: 'Use "${use}" instead.'
    }
  ],
  [
    "resolve/unused-variable",
    {
      summary: "Unused variable",
      reason: '"${symbol}" is declared but its value is never used.',
      fix: 'Remove it or prefix with "_" to silence.'
    }
  ],
  [
    "selector/duplicate",
    {
      summary: "Duplicate selector",
      reason: 'Selector "${selector}" is defined multiple times.',
      fix: "Consolidate rules or remove the duplicate."
    }
  ],
  [
    "selector/parentless-ampersand",
    {
      summary: "Parentless ampersand ignored",
      reason: 'Selector "${selector}" uses "&" without an available parent selector in this context.',
      fix: 'Move the selector under a real parent selector, or remove the stray "&".'
    }
  ],
  [
    "selector/comma-list-interpolation",
    {
      summary: "Comma-list value in a selector",
      reason: 'The value interpolated into selector "${selector}" is a comma-separated list; a list can\'t be spliced into a selector position.',
      fix: "Use each() to distribute a rule over a list instead of interpolating the list into the selector."
    }
  ],
  [
    "plugin/function-threw",
    {
      summary: 'Plugin function "${name}" threw',
      reason: 'The @plugin function "${name}" failed while evaluating this call: ${reason}',
      fix: "Fix the plugin function (its stack is attached), or stop calling it here. Run with breakOnError to stop at the first failure."
    }
  ],
  [
    "eval/async-in-sync-position",
    {
      summary: "Value needs to be awaited in a position that cannot wait",
      reason: "The ${where} still requires an already-settled value, but this one resolves asynchronously (typically a function call that returns a promise).",
      fix: "Bind the value to a variable evaluated outside this position, or call the mixin directly instead of through a namespace path."
    }
  ],
  [
    "plugin/load-failed",
    {
      /*
       * The summary carries the underlying failure verbatim: a load error is only
       * actionable if it says WHY, and the summary is what a thrown error's
       * message shows.
       */
      summary: 'Plugin "${specifier}" could not be loaded: ${reason}',
      reason: "Loading the @plugin failed: ${reason}",
      fix: "Check the plugin path and that the script runs without throwing at load time."
    }
  ],
  [
    "plugin/log",
    {
      summary: 'Plugin function "${name}" reported a problem',
      reason: "${level}: ${message}",
      fix: "Address what the plugin reported, or stop calling it here."
    }
  ]
]);
var JESS_ERROR_CODE_SET = new Set(TEMPLATES.keys());
function isJessErrorCode(code) {
  return JESS_ERROR_CODE_SET.has(code);
}
function isParseErrorCode(code) {
  return code.startsWith("parse/") && JESS_ERROR_CODE_SET.has(code);
}
function resolveTemplate(code, meta) {
  const t = TEMPLATES.get(code) ?? TEMPLATES.get("parse/syntax-error");
  return {
    summary: interpolate(t.summary, meta),
    reason: interpolate(t.reason, meta),
    fix: interpolate(t.fix, meta)
  };
}
function interpolate(s, meta) {
  return s.replace(
    /\$\{(\w+)\}/g,
    (_, k) => String(meta[k] ?? `<${k}>`)
  );
}

// packages/core/src/error/code-frame.ts
var sourceIndexes = /* @__PURE__ */ new WeakMap();
function buildSourceIndex(source, owner) {
  const lineStarts = [0];
  for (let offset = 0; offset < source.length; offset++) {
    if (source.charCodeAt(offset) === 10) {
      lineStarts.push(offset + 1);
    }
  }
  const start = Math.min(owner?.sourceOffset ?? 0, source.length);
  const originLine = lineIndexAt(lineStarts, start);
  const end = owner?.sourceEnd;
  return {
    source,
    lineStarts,
    originLine,
    originColumn: start - lineStarts[originLine],
    lastLine: end === void 0 ? lineStarts.length - 1 : lineIndexAt(lineStarts, Math.max(start, end - 1))
  };
}
function sourceIndex(source, owner) {
  const cached = owner === void 0 ? void 0 : sourceIndexes.get(owner);
  if (cached?.source === source) {
    return cached;
  }
  const indexed = buildSourceIndex(source, owner);
  if (owner !== void 0) {
    sourceIndexes.set(owner, indexed);
  }
  return indexed;
}
function lineIndexAt(lineStarts, offset) {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low < high) {
    const middle = low + high + 1 >>> 1;
    if (lineStarts[middle] <= offset) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return low;
}
var INJECTED_TEXT_NOTE = "This is in text the compiler added around the file (Less `banner`, `globalVars` or `modifyVars`), not in the file as written.";
function fileAt(file, source, offset) {
  const start = file.sourceOffset ?? 0;
  const end = file.sourceEnd ?? source.length;
  if (offset >= start && offset <= end) {
    return file;
  }
  return { ...file, sourceOffset: void 0, sourceEnd: void 0 };
}
function lineColAt(source, offset, owner) {
  const end = Math.min(offset, source.length);
  const indexed = sourceIndex(source, owner);
  const index = lineIndexAt(indexed.lineStarts, end);
  const column = end - indexed.lineStarts[index] + 1;
  return {
    line: index - indexed.originLine + 1,
    column: index === indexed.originLine ? column - indexed.originColumn : column
  };
}
function extractRelevantLines(source, line, contextLines = 1, owner) {
  if (!source) {
    return void 0;
  }
  const { lineStarts, originLine, originColumn, lastLine } = sourceIndex(source, owner);
  const index = Math.max(0, Math.min(line - 1 + originLine, lineStarts.length - 1));
  const inside = index >= originLine && index <= lastLine;
  const first = Math.max(inside ? originLine : 0, index - contextLines);
  const last = Math.min(inside ? lastLine : lineStarts.length - 1, index + contextLines);
  const result = {};
  for (let i = first; i <= last; i++) {
    const from = i === originLine ? lineStarts[i] + originColumn : lineStarts[i];
    const next = lineStarts[i + 1] ?? source.length;
    const newline = next > from && source.charCodeAt(next - 1) === 10 ? 1 : 0;
    const carriageReturn = newline === 1 && next - from > 1 && source.charCodeAt(next - 2) === 13 ? 1 : 0;
    result[i - originLine + 1] = source.slice(from, next - newline - carriageReturn);
  }
  return result;
}

// packages/core/src/error/jess-error.ts
function inlineSpanStart(node) {
  if (node === void 0 || !("spanStart" in node)) {
    return void 0;
  }
  return typeof node.spanStart === "number" ? node.spanStart : void 0;
}
function inlineSpanEnd(node) {
  if (node === void 0 || !("spanEnd" in node)) {
    return void 0;
  }
  return typeof node.spanEnd === "number" ? node.spanEnd : void 0;
}
var JessError = class {
  name = "JessError";
  message;
  severity = "error";
  code = "parse/syntax-error";
  phase = "parse";
  // Resolved source context (fileObj preferred; filePath is legacy)
  fileObj;
  filePath;
  line = 1;
  column = 1;
  endLine;
  endColumn;
  source;
  node;
  // Store node to derive endLine/endColumn on demand
  reason = "";
  fix = "";
  note;
  constructor(init) {
    const authored = init.ctx?.file;
    const source = authored?.source ?? init.source;
    const nodeOffset = inlineSpanStart(init.node);
    const fileObj = authored !== void 0 && nodeOffset !== void 0 && source !== void 0 ? fileAt(authored, source, nodeOffset) : authored;
    const derived = nodeOffset !== void 0 && source !== void 0 ? lineColAt(source, nodeOffset, fileObj) : void 0;
    const t = resolveTemplate(init.code, init.meta ?? {});
    this.message = init.summary ?? t.summary;
    this.severity = init.severity ?? "error";
    this.code = init.code;
    this.phase = init.phase;
    this.fileObj = fileObj;
    this.filePath = fileObj?.fullPath ?? init.filePath;
    this.line = derived?.line ?? init.line ?? 1;
    this.column = derived?.column ?? init.column ?? 1;
    this.endLine = init.endLine;
    this.endColumn = init.endColumn;
    this.source = source;
    this.node = init.node;
    this.reason = init.reason ?? t.reason;
    this.fix = init.fix ?? t.fix;
    this.note = init.note ?? (fileObj === authored ? void 0 : INJECTED_TEXT_NOTE);
  }
  /**
   * Attributes a diagnostic raised by code that knew no source (a plugin
   * runtime refusing a Less 4 hook, a disabled `@plugin` load) to the statement
   * or call it was raised under. One that already has a location keeps it.
   */
  attributeTo(at) {
    if (this.filePath === void 0) {
      this.fileObj = at.ctx?.file;
      this.filePath = this.fileObj?.fullPath;
      this.source = this.fileObj?.source;
      this.line = at.line ?? this.line;
      this.column = at.column ?? this.column;
    }
    return this;
  }
  /** Plain-text diagnostic: header + reason/fix. No colors, links, or frame. */
  toString() {
    const loc = this.filePath ? `${this.filePath}:${this.line}:${this.column}` : "(unknown)";
    return [
      `${this.severity} ${this.code} [${this.phase}] ${loc} — ${this.message}`,
      `Reason: ${this.reason}`,
      `Fix: ${this.fix}`,
      this.note ? `Note: ${this.note}` : void 0
    ].filter(Boolean).join("\n");
  }
};

// packages/core/src/error/diagnostics.ts
function parserFailureFrom(error) {
  if (typeof error !== "object" || error === null || !("offset" in error)) {
    return void 0;
  }
  const offset = error.offset;
  if (typeof offset !== "number" || !Number.isFinite(offset)) {
    return void 0;
  }
  const endOffset = "endOffset" in error && typeof error.endOffset === "number" && Number.isFinite(error.endOffset) ? error.endOffset : void 0;
  const line = "line" in error && typeof error.line === "number" && Number.isFinite(error.line) ? error.line : void 0;
  const column = "column" in error && typeof error.column === "number" && Number.isFinite(error.column) ? error.column : void 0;
  const endLine = "endLine" in error && typeof error.endLine === "number" && Number.isFinite(error.endLine) ? error.endLine : void 0;
  const endColumn = "endColumn" in error && typeof error.endColumn === "number" && Number.isFinite(error.endColumn) ? error.endColumn : void 0;
  const expected = "expected" in error && Array.isArray(error.expected) ? Array.from(new Set(error.expected.filter(
    (value) => typeof value === "string"
  ))) : void 0;
  const code = "code" in error && typeof error.code === "string" && isParseErrorCode(error.code) ? error.code : void 0;
  const reason = "reason" in error && typeof error.reason === "string" ? error.reason : void 0;
  const fix = "fix" in error && typeof error.fix === "string" ? error.fix : void 0;
  return { code, offset, endOffset, line, column, endLine, endColumn, expected, reason, fix };
}
var SINGLE_QUOTE = "'";
function hasExpected(expected, value) {
  return expected.has(value);
}
function expectedValueSummary(dialect, expected) {
  if (expected === void 0 || expected.length === 0) {
    return void 0;
  }
  const expectedSet = new Set(expected);
  const looksLikeValueProduction = hasExpected(expectedSet, "NumberToken") && hasExpected(expectedSet, "DimensionUnit") && hasExpected(expectedSet, "not(regex)") && (hasExpected(expectedSet, "LessSyntaxKeyword") || hasExpected(expectedSet, "HexColor"));
  if (!looksLikeValueProduction) {
    return void 0;
  }
  return {
    code: "parse/invalid-value",
    message: "Invalid value.",
    reason: `${dialect} expected a value here, but this token cannot start one.`,
    fix: "Rewrite this position as a valid value or move the syntax into a statement position."
  };
}
function expectedClosingDelimiterSummary(dialect, expected) {
  if (expected?.length !== 1) {
    return void 0;
  }
  switch (expected[0]) {
    case '")"':
      return {
        code: "parse/syntax-error",
        message: "Missing closing parenthesis.",
        reason: `${dialect} expected ')' to close the open construct before this token.`,
        fix: "Add the missing ')' or remove the unmatched '('."
      };
    case '"]"':
      return {
        code: "parse/syntax-error",
        message: "Missing closing bracket.",
        reason: `${dialect} expected ']' to close the open construct before this token.`,
        fix: "Add the missing ']' or remove the unmatched '['."
      };
    case '"}"':
      return {
        code: "parse/syntax-error",
        message: "Missing closing brace.",
        reason: `${dialect} expected '}' to close the open construct before this token.`,
        fix: "Add the missing '}' or remove the unmatched '{'."
      };
    default:
      return void 0;
  }
}
function expectedSemicolonSummary(dialect, expected) {
  if (expected?.length !== 1 || expected[0] !== '";"') {
    return void 0;
  }
  return {
    code: "parse/syntax-error",
    message: "Missing semicolon.",
    reason: `${dialect} expected ';' before this token.`,
    fix: "Add the missing ';' or rewrite the statement."
  };
}
function isClassOrIdSelectorToken(token) {
  return token.startsWith("/[.#]");
}
function expectedSelectorContextSummary(dialect, expected) {
  if (expected === void 0 || expected.length === 0) {
    return void 0;
  }
  const expectedSet = new Set(expected);
  const canOpenBlock = hasExpected(expectedSet, '"{"');
  const canCallMixin = hasExpected(expectedSet, '"("');
  const canContinueSelector = hasExpected(expectedSet, "/>/") || expected.some(isClassOrIdSelectorToken);
  if (!(canOpenBlock && canCallMixin && canContinueSelector)) {
    return void 0;
  }
  return {
    code: "parse/syntax-error",
    message: "Expected a selector, mixin call, or block.",
    reason: `${dialect} expected a selector, mixin call, or block to continue here, but this token starts none of them.`,
    fix: "Continue the selector, call a mixin, or open a block with '{'."
  };
}
function expectedSyntaxSummary(dialect, expected) {
  return expectedValueSummary(dialect, expected) ?? expectedClosingDelimiterSummary(dialect, expected) ?? expectedSemicolonSummary(dialect, expected) ?? expectedSelectorContextSummary(dialect, expected);
}
function surfaceableExpectedTokens(expected) {
  return expected.filter((token) => /^".*"$/.test(token));
}
function matchingCloser(opener) {
  switch (opener) {
    case "(":
      return ")";
    case "[":
      return "]";
    case "{":
      return "}";
    default:
      return void 0;
  }
}
function isOpeningDelimiter(value) {
  return value === "(" || value === "[" || value === "{";
}
function isClosingDelimiter(value) {
  return value === ")" || value === "]" || value === "}";
}
function followsClosingDelimiter(source, index) {
  for (let i = index - 1; i >= 0; i--) {
    const ch = source[i];
    if (ch === " " || ch === "	" || ch === "\n" || ch === "\r" || ch === "\f") {
      continue;
    }
    return isClosingDelimiter(ch);
  }
  return false;
}
function delimiterConflictSummary(dialect, source) {
  const stack = [];
  let quote;
  let quoteOffset = -1;
  let inBlockComment = false;
  let inLineComment = false;
  for (let i = 0; i < source.length; i++) {
    const current = source[i];
    const next = source[i + 1];
    if (inLineComment) {
      if (current === "\n") {
        inLineComment = false;
      }
      continue;
    }
    if (inBlockComment) {
      if (current === "*" && next === "/") {
        inBlockComment = false;
        i++;
      }
      continue;
    }
    if (quote !== void 0) {
      if (current === "\\") {
        i++;
        continue;
      }
      if (current === quote) {
        quote = void 0;
        quoteOffset = -1;
      }
      continue;
    }
    if (current === "/" && next === "/") {
      inLineComment = true;
      i++;
      continue;
    }
    if (current === "/" && next === "*") {
      inBlockComment = true;
      i++;
      continue;
    }
    if (current === '"' || current === SINGLE_QUOTE) {
      quote = current;
      quoteOffset = i;
      continue;
    }
    if (isOpeningDelimiter(current)) {
      const closer = matchingCloser(current);
      if (closer === void 0) {
        continue;
      }
      const top2 = stack[stack.length - 1];
      const insideBlock = stack.includes("}");
      if (top2 !== void 0 && top2 !== "}" && current === "{" && !insideBlock && !followsClosingDelimiter(source, i)) {
        const summary2 = expectedClosingDelimiterSummary(dialect, [`"${top2}"`]);
        return summary2 === void 0 ? void 0 : { ...summary2, offset: i };
      }
      stack.push(closer);
      continue;
    }
    if (isClosingDelimiter(current)) {
      const top2 = stack[stack.length - 1];
      if (top2 === void 0) {
        continue;
      }
      if (top2 !== current) {
        const summary2 = expectedClosingDelimiterSummary(dialect, [`"${top2}"`]);
        return summary2 === void 0 ? void 0 : { ...summary2, offset: i };
      }
      stack.pop();
    }
  }
  if (quote !== void 0) {
    return {
      code: "parse/unterminated-string",
      message: "Unterminated string.",
      reason: `${dialect} expected the quoted string to be closed before the end of the source.`,
      fix: "Add the missing closing quote.",
      offset: quoteOffset
    };
  }
  const top = stack[stack.length - 1];
  if (top === void 0) {
    return void 0;
  }
  const summary = expectedClosingDelimiterSummary(dialect, [`"${top}"`]);
  return summary === void 0 ? void 0 : { ...summary, offset: source.length };
}
function sourceSyntaxSummary(dialect, source, failure) {
  if (failure === void 0 || failure.code !== void 0 && failure.code !== "parse/syntax-error") {
    return void 0;
  }
  if (expectedSyntaxSummary(dialect, failure.expected) !== void 0) {
    return void 0;
  }
  return delimiterConflictSummary(dialect, source);
}
function parserDiagnostic({
  dialect,
  error,
  filePath,
  source
}) {
  const failure = parserFailureFrom(error);
  const sourceSummary = sourceSyntaxSummary(dialect, source, failure);
  const offset = Math.max(
    0,
    Math.min(source.length, sourceSummary?.offset ?? failure?.offset ?? 0)
  );
  const endOffset = failure?.endOffset === void 0 ? void 0 : Math.max(offset, Math.min(source.length, failure.endOffset));
  const startLoc = sourceSummary === void 0 && failure?.line !== void 0 && failure.column !== void 0 ? { line: failure.line, column: failure.column } : lineColAt(source, offset);
  const endLoc = failure?.endLine !== void 0 && failure.endColumn !== void 0 ? { line: failure.endLine, column: failure.endColumn } : endOffset === void 0 ? void 0 : lineColAt(source, endOffset);
  const message = error instanceof JessError ? error.message : error instanceof Error ? error.message : `${dialect} parser error.`;
  const expected = failure?.expected;
  const expectedSummary = failure?.code === void 0 || failure.code === "parse/syntax-error" ? expectedSyntaxSummary(dialect, expected) : void 0;
  const syntaxSummary = expectedSummary ?? sourceSummary;
  return {
    code: syntaxSummary?.code ?? failure?.code ?? "parse/syntax-error",
    phase: "parse",
    message: syntaxSummary?.message ?? message,
    reason: sourceSummary?.reason ?? failure?.reason ?? expectedSummary?.reason ?? (() => {
      const surfaceable = expected ? surfaceableExpectedTokens(expected) : [];
      return surfaceable.length > 0 ? `The parser expected ${surfaceable.join(", ")}.` : "The parser could not continue at this source location.";
    })(),
    fix: sourceSummary?.fix ?? failure?.fix ?? expectedSummary?.fix ?? `Check the ${dialect} source against the supported grammar.`,
    file: { name: filePath, path: filePath, fullPath: filePath, source },
    filePath,
    line: startLoc.line,
    column: startLoc.column,
    endLine: endLoc?.line,
    endColumn: endLoc?.column,
    lines: extractRelevantLines(source, startLoc.line)
  };
}
function makeJessError(init) {
  return new JessError(init);
}
var LeadingSeparatorValueError = class extends SyntaxError {
  code = "parse/leading-separator-value";
  offset;
  endOffset;
  reason;
  fix;
  /** The value the parse kept for it; a report whose value is not in the accepted tree is dropped. */
  recoveredValue;
  constructor(offset, endOffset, operator, recoveredValue) {
    const text = leadingSeparatorValueText(operator);
    super(text.summary);
    this.name = "LeadingSeparatorValueError";
    this.offset = offset;
    this.endOffset = endOffset;
    this.reason = text.reason;
    this.fix = text.fix;
    this.recoveredValue = recoveredValue;
  }
};
var DeprecatedIfFunctionWarning = class extends SyntaxError {
  code = "parse/deprecated-if-function";
  severity = "warn";
  offset;
  endOffset;
  reason;
  fix;
  constructor(offset, endOffset) {
    const text = resolveTemplate("parse/deprecated-if-function", {});
    super(text.summary);
    this.name = "DeprecatedIfFunctionWarning";
    this.offset = offset;
    this.endOffset = endOffset;
    this.reason = text.reason;
    this.fix = text.fix;
  }
};
var NO_VISITORS = "Less v5 has no visitor API: remove the plugin, or port what it does to a function plugin or to a step that runs on the compiled CSS.";
var NO_PRE_PROCESSORS = "Less v5 does not run source pre-processors: transform the source before it reaches the compiler.";
var NO_POST_PROCESSORS = "Less v5 does not run CSS post-processors: for minification (less-plugin-clean-css) set output.compress (`compress` in less.render / lessc); otherwise run the tool, e.g. PostCSS with autoprefixer, on the compiled CSS.";
var NO_FILE_MANAGERS = "Less v5 has no custom file managers: for npm imports (less-plugin-npm-import) use @jesscss/plugin-node-modules; other import resolution belongs in a Jess plugin's resolve/locate hooks.";
var VALUES_ONLY = "A Less v5 function plugin returns a value (a dimension, color, string, keyword, list or declaration list): write the rest in the stylesheet.";
var UNSUPPORTED_TREE_NODE_REASONS = [
  ["AtRule", `At-rules are statements, not values. ${VALUES_ONLY}`],
  ["Attribute", `Attribute selectors are selector structure. ${VALUES_ONLY}`],
  ["Combinator", `Combinators are selector structure. ${VALUES_ONLY}`],
  ["Condition", `Guard conditions are evaluated by the compiler. ${VALUES_ONLY}`],
  ["Element", `Selector elements are selector structure. ${VALUES_ONLY}`],
  ["Extend", `:extend is resolved by the compiler. ${VALUES_ONLY}`],
  ["Import", `@import is resolved while documents load, before plugin functions run. ${VALUES_ONLY}`],
  ["JavaScript", "Inline JavaScript evaluation was removed: write the expression as a function plugin."],
  ["Media", `@media is a statement, not a value. ${VALUES_ONLY}`],
  ["MixinCall", `Mixin calls are dispatched by the compiler. ${VALUES_ONLY}`],
  ["MixinDefinition", `Mixin definitions are statements, not values. ${VALUES_ONLY}`],
  ["NamespaceValue", `Namespace lookups are resolved by the compiler. ${VALUES_ONLY}`],
  ["Selector", `Selectors are statement structure. ${VALUES_ONLY}`],
  ["VariableCall", `Detached-ruleset calls are dispatched by the compiler. ${VALUES_ONLY}`]
];
var UNSUPPORTED_LESS_TREE_NODES = UNSUPPORTED_TREE_NODE_REASONS.map(([name]) => name);
var UNSUPPORTED_PLUGIN_API_REPLACEMENTS = new Map([
  ["pluginManager.addVisitor()", NO_VISITORS],
  ["pluginManager.getVisitors()", NO_VISITORS],
  ["pluginManager.visitor()", NO_VISITORS],
  ["pluginManager.visitors", NO_VISITORS],
  ["pluginManager.iterator", NO_VISITORS],
  ["pluginManager.addPreProcessor()", NO_PRE_PROCESSORS],
  ["pluginManager.getPreProcessors()", NO_PRE_PROCESSORS],
  ["pluginManager.preProcessors", NO_PRE_PROCESSORS],
  ["pluginManager.addPostProcessor()", NO_POST_PROCESSORS],
  ["pluginManager.getPostProcessors()", NO_POST_PROCESSORS],
  ["pluginManager.postProcessors", NO_POST_PROCESSORS],
  ["pluginManager.addFileManager()", NO_FILE_MANAGERS],
  ["pluginManager.getFileManagers()", NO_FILE_MANAGERS],
  ["pluginManager.fileManagers", NO_FILE_MANAGERS],
  ["pluginManager.Loader", "Less v5 loads plugins only from @plugin and the plugins option: declare the plugin there, or install it from this one with pluginManager.addPlugin()."],
  /* 4.x plugins reach these before the hook call (`new less.visitors.Visitor(this)`). */
  ["less.visitors", NO_VISITORS],
  ["less.FileManager", NO_FILE_MANAGERS],
  ["less.environment", NO_FILE_MANAGERS],
  ...UNSUPPORTED_TREE_NODE_REASONS.map(([name, reason]) => [`tree.${name}`, reason]),
  ["tree.Ruleset with selectors", `Only an anonymous declaration list crosses the plugin value boundary. ${VALUES_ONLY}`]
]);
function makeJessErrorFromDiagnostic(diagnostic) {
  const code = isJessErrorCode(diagnostic.code) ? diagnostic.code : "parse/syntax-error";
  return new JessError({
    code,
    phase: diagnostic.phase,
    severity: "error",
    summary: diagnostic.message,
    ctx: diagnostic.file ? { file: diagnostic.file } : void 0,
    filePath: diagnostic.filePath,
    source: diagnostic.file?.source,
    line: diagnostic.line,
    column: diagnostic.column,
    endLine: diagnostic.endLine,
    endColumn: diagnostic.endColumn,
    reason: diagnostic.reason,
    fix: diagnostic.fix,
    note: diagnostic.note
  });
}
var ERR = {
  // Parse/Lex
  unexpectedToken(args) {
    return makeJessError({
      code: "parse/unexpected-token",
      phase: "parse",
      ...args
    });
  },
  unterminatedString(args = {}) {
    return makeJessError({
      code: "parse/unterminated-string",
      phase: "parse",
      ...args
    });
  },
  // Resolve/Import
  nameNotFound(args) {
    return makeJessError({
      code: "resolve/name-not-found",
      phase: "resolve",
      ...args
    });
  },
  ambiguousMember(args) {
    return makeJessError({
      code: "resolve/ambiguous-member",
      phase: "resolve",
      ...args
    });
  },
  namespaceShadowed(args) {
    return makeJessError({
      code: "resolve/namespace-shadowed",
      phase: "resolve",
      ...args
    });
  },
  circularCompose(args) {
    return makeJessError({
      code: "import/circular-compose",
      phase: "import",
      ...args
    });
  },
  composeNotTopLevel(args) {
    return makeJessError({
      code: "compose/not-top-level",
      phase: "import",
      ...args
    });
  },
  importCycle(args) {
    return makeJessError({
      code: "import/cycle",
      phase: "import",
      ...args
    });
  },
  importNotFound(args) {
    return makeJessError({
      code: "import/not-found",
      phase: "import",
      ...args
    });
  },
  importLoadFailed(args) {
    return makeJessError({
      code: "import/load-failed",
      phase: "import",
      ...args
    });
  },
  // Eval
  arity(args) {
    return makeJessError({
      code: "eval/bad-call-arity",
      phase: "eval",
      ...args
    });
  },
  typeMismatch(args) {
    return makeJessError({
      code: "eval/type-mismatch",
      phase: "eval",
      ...args
    });
  },
  invalidFunction(args) {
    return makeJessError({
      code: "eval/invalid-function",
      phase: "eval",
      ...args
    });
  },
  invalidStatement(args) {
    return makeJessError({
      code: "eval/invalid-statement",
      phase: "eval",
      ...args
    });
  },
  ambiguousDefault(args) {
    return makeJessError({
      code: "eval/ambiguous-default",
      phase: "eval",
      ...args
    });
  },
  propertyInRoot(args) {
    return makeJessError({
      code: "eval/property-in-root",
      phase: "eval",
      ...args
    });
  },
  rulesetArgumentWithRules(args) {
    return makeJessError({
      code: "eval/ruleset-argument-with-rules",
      phase: "eval",
      ...args
    });
  },
  guardedSelectorList(args) {
    return makeJessError({
      code: "eval/guarded-selector-list",
      phase: "eval",
      ...args
    });
  },
  rulesetOnProperty(args) {
    return makeJessError({
      code: "eval/ruleset-on-property",
      phase: "eval",
      ...args
    });
  },
  uncalledMixinReference(args) {
    return makeJessError({
      code: "eval/uncalled-mixin-reference",
      phase: "eval",
      ...args
    });
  },
  recursiveReference(args) {
    return makeJessError({
      code: "eval/recursive-reference",
      phase: "eval",
      ...args
    });
  },
  /**
   * A `$while` whose condition never settled false. The limit is a TERMINATION
   * guarantee, not a tuning knob: without it a loop whose body never moves the
   * condition hangs the compiler with no output and no message.
   */
  loopIterationLimit(args) {
    return makeJessError({
      code: "eval/loop-iteration-limit",
      phase: "eval",
      ...args
    });
  },
  /**
   * A mixin that never stops expanding itself: a guard that never fails, or no
   * guard. Reported at the call, whether the expansion depth limit or the native
   * call stack ran out first.
   */
  mixinRecursionLimit(args) {
    return makeJessError({
      code: "eval/mixin-recursion-limit",
      phase: "eval",
      ...args
    });
  },
  /**
   * A division the author asked for — `math: always`, a paren group, `$( … )` —
   * whose divisor is zero. There is no quotient to print, and printing the
   * operation verbatim would hide the mistake, so it is an error in every
   * `unitMode` (DESIGN-DECISIONS P35).
   */
  divisionByZero(args) {
    return makeJessError({
      code: "eval/division-by-zero",
      phase: "eval",
      ...args
    });
  },
  invalidUnitArithmetic(args) {
    return makeJessError({
      code: "eval/invalid-unit-arithmetic",
      phase: "eval",
      ...args
    });
  },
  /**
   * A Sass `@error` directive — the author asked the compile to halt with this
   * message. The evaluated message IS the summary; there is nothing to add.
   */
  scssError(args) {
    return makeJessError({
      code: "eval/scss-error",
      phase: "eval",
      ...args
    });
  },
  /**
   * A RELATIONAL comparison whose operands share no common ground (`1px > red`).
   * Relational is trichotomous over every grounded pair, so the alternative is
   * answering `false` to both `a > b` and `b > a` — which is what the author
   * cannot distinguish from a genuine "not greater".
   */
  emptyOperand(args) {
    return makeJessError({
      code: "eval/empty-operand",
      phase: "eval",
      ...args
    });
  },
  /**
   * An empty list written where CSS needs a value: a declaration value or an
   * argument of a call written out as-is (ledger P51; Dart Sass: "() isn't a
   * valid CSS value"). Writing nothing would lose the authored `()` (P37).
   */
  emptyListValue(args) {
    return makeJessError({
      code: "eval/empty-list-value",
      phase: "eval",
      ...args
    });
  },
  /**
   * An operation on an operand it is not defined on, where the operation
   * computes (DESIGN-DECISIONS V36): a keyword or a string in every dialect, in
   * Less also a call written out as-is, in `.scss` and `.jess` also a boolean,
   * a list and a map. The result would mean nothing, so the compile fails.
   */
  invalidOperand(args) {
    return makeJessError({
      code: "eval/invalid-operand",
      phase: "eval",
      ...args
    });
  },
  incomparableOperands(args) {
    return makeJessError({
      code: "eval/incomparable-operands",
      phase: "eval",
      ...args
    });
  },
  /**
   * A value resolved asynchronously in one of the few positions still confined
   * to the synchronous lane. A real limitation, not a wrong answer: it names the
   * position and the site rather than silently picking a branch.
   */
  asyncInSyncPosition(args) {
    return makeJessError({
      code: "eval/async-in-sync-position",
      phase: "eval",
      ...args
    });
  },
  // Extend
  extendBoundary(args) {
    return makeJessError({
      code: "extend/protected-boundary",
      phase: "extend",
      ...args
    });
  },
  extendNotFound(args) {
    return makeJessError({
      code: "extend/not-found",
      phase: "extend",
      ...args
    });
  },
  extendNotAccessible(args) {
    return makeJessError({
      code: "extend/not-accessible",
      phase: "extend",
      ...args
    });
  },
  commaListInterpolation(args) {
    return makeJessError({
      code: "selector/comma-list-interpolation",
      phase: "eval",
      ...args
    });
  },
  /**
   * Legacy Internet Explorer syntax — a `progid:` value or a `name=value` call
   * argument — parsed as balanced CSS and is then an error (owner 2026-10-16:
   * "parsed fine, but then errored").
   */
  legacyIeSyntax(args) {
    return makeJessError({
      code: "css/legacy-ie-syntax",
      phase: "parse",
      ...args
    });
  },
  /**
   * A value-position `selector(…)` whose argument is not a selector list
   * (ledger P49): parsed, then an error (P45).
   */
  selectorCaptureArgument(args = {}) {
    return makeJessError({
      code: "parse/selector-capture-argument",
      phase: "parse",
      ...args
    });
  },
  /** A value led by a `/` or `*` with nothing on its left (ledger P33), parsed and then an error (P45). */
  leadingSeparatorValue(operator, args = {}) {
    const text = leadingSeparatorValueText(operator);
    return makeJessError({
      code: "parse/leading-separator-value",
      phase: "parse",
      summary: text.summary,
      reason: text.reason,
      fix: text.fix,
      ...args
    });
  },
  /** A `.jess` `*` between two numbers or variables outside `$( … )` (ledger P17; P45: parsed, then an error). */
  arithmeticOutsideExpression(args = {}) {
    return makeJessError({
      code: "parse/arithmetic-outside-expression",
      phase: "parse",
      ...args
    });
  },
  /**
   * A delim no CSS value accepts — `.`, `~`, `=`, `|`, `^` or `?` — parsed as
   * balanced CSS and is then an error (owner 2026-10-16: "the point of parsing
   * valid CSS isn't that we're obligated to actually accept everything").
   */
  invalidValuePunctuation(args) {
    return makeJessError({
      code: "css/invalid-value-punctuation",
      phase: "parse",
      ...args
    });
  },
  /**
   * An `@supports` prelude term that is no `<supports-in-parens>` — an
   * identifier, as in `selector (a)` or `color` — parsed as balanced CSS and
   * then an error (owner 2026-10-22; ledger P45).
   */
  invalidSupportsCondition(args) {
    return makeJessError({
      code: "css/invalid-supports-condition",
      phase: "parse",
      ...args
    });
  },
  // Plugin
  /**
   * A plugin reached for an API this compiler deliberately does not provide
   * (e.g. a Less 4 plugin-manager hook). The fix names the native replacement
   * from {@link UNSUPPORTED_PLUGIN_API_REPLACEMENTS}.
   */
  pluginUnsupported(args) {
    return makeJessError({
      code: "plugin/unsupported-feature",
      phase: "plugin",
      ...args,
      meta: {
        ...args.meta,
        replacement: UNSUPPORTED_PLUGIN_API_REPLACEMENTS.get(args.meta.feature) ?? "Remove the plugin, or replace what it does with a supported plugin API."
      }
    });
  },
  /**
   * A plugin option is set to a value outside its documented set. Options are
   * not a stylesheet, so the diagnostic names the option, and `filePath` is the
   * config file when one sets the value; a value passed in code has no file.
   */
  pluginInvalidOption(args) {
    return makeJessError({
      code: "plugin/invalid-option",
      phase: "plugin",
      ...args
    });
  },
  /** A `@plugin`/`@use` function raised — user code failed, not a value mismatch. */
  pluginFunctionThrew(args) {
    return makeJessError({
      code: "plugin/function-threw",
      phase: "plugin",
      ...args
    });
  },
  /**
   * A `@plugin` could not be loaded — the path did not resolve, or the script
   * threw while installing. The phase is `eval` because the load happens while
   * the enclosing body evaluates, at the `@plugin` statement's position.
   */
  pluginLoadFailed(args) {
    return makeJessError({
      code: "plugin/load-failed",
      phase: "eval",
      ...args
    });
  }
};
var WARN = {
  deprecated(args) {
    return makeJessError({
      severity: "warn",
      code: "eval/deprecated",
      phase: "eval",
      ...args
    });
  },
  unusedVar(args) {
    return makeJessError({
      severity: "warn",
      code: "resolve/unused-variable",
      phase: "resolve",
      ...args
    });
  },
  duplicateSelector(args) {
    return makeJessError({
      severity: "warn",
      code: "selector/duplicate",
      phase: "extend",
      ...args
    });
  },
  parentlessAmpersand(args) {
    return makeJessError({
      severity: "warn",
      code: "selector/parentless-ampersand",
      phase: "eval",
      ...args
    });
  },
  /**
   * §4.7 — a value whose composed unit CSS cannot express. Raised on the
   * `loose` and `preserve` rungs of the `unitMode` ladder, which both PRODUCE a
   * value: `loose` folds to Less 4.x's dimensionally false answer and
   * `preserve` says the authored expression back as `calc(…)`. Neither is
   * silent, because a plausible-looking wrong answer is worse than a
   * diagnostic. Only `strict`, which refuses the value outright, reports
   * through `ERR` instead.
   */
  unexpressibleUnit(args) {
    return makeJessError({
      severity: "warn",
      code: "eval/unexpressible-unit",
      phase: "eval",
      ...args
    });
  },
  unitConversion(args) {
    return makeJessError({
      severity: "warn",
      code: "eval/unit-conversion",
      phase: "eval",
      ...args
    });
  },
  extendNotFound(args) {
    return makeJessError({
      severity: "warn",
      code: "extend/not-found",
      phase: "extend",
      ...args
    });
  },
  extendNotAccessible(args) {
    return makeJessError({
      severity: "warn",
      code: "extend/not-accessible",
      phase: "extend",
      ...args
    });
  },
  /**
   * A `@plugin`/`@use` function raised and the render continued. The call is
   * preserved verbatim, but never silently: this names the function, the throw,
   * and the call site.
   */
  pluginFunctionThrew(args) {
    return makeJessError({
      severity: "warn",
      code: "plugin/function-threw",
      phase: "plugin",
      ...args
    });
  },
  /** A record a plugin emitted through `less.logger`, attributed to its call site. */
  pluginLog(args) {
    return makeJessError({
      severity: "warn",
      code: "plugin/log",
      phase: "plugin",
      ...args
    });
  }
};
function toDiagnostic(error, options) {
  const source = error.source ?? error.fileObj?.source;
  const lines = options?.includeLines === false ? void 0 : extractRelevantLines(source, error.line, 1, error.fileObj);
  const endOffset = inlineSpanEnd(error.node);
  const endLc = error.endLine === void 0 && error.endColumn === void 0 && endOffset !== void 0 && source !== void 0 ? lineColAt(source, endOffset, error.fileObj) : void 0;
  const file = error.fileObj ? {
    name: error.fileObj.name,
    path: error.fileObj.path,
    fullPath: error.fileObj.fullPath
  } : void 0;
  return {
    code: error.code,
    phase: error.phase,
    message: error.message,
    reason: error.reason,
    fix: error.fix,
    note: error.note,
    file,
    filePath: error.filePath,
    line: error.line,
    column: error.column,
    endLine: error.endLine ?? endLc?.line,
    endColumn: error.endColumn ?? endLc?.column,
    lines
  };
}

// packages/core/src/ast/supports-condition.ts
function isInSupportsGroup(state) {
  return typeof state === "object" && state !== null && "supportsGroup" in state && state.supportsGroup === true;
}
function enterSupportsGroup(state) {
  return typeof state === "object" && state !== null ? { ...state, supportsGroup: true } : { supportsGroup: true };
}

// packages/core/src/ast/forgiving-selector.ts
var CSS_LEADING_WHITESPACE = /^[ \t\n\r\f]+/u;
var CSS_TRAILING_WHITESPACE = /[ \t\n\r\f]+$/u;
function isForgivingSelectorRest(value) {
  return typeof value === "object" && value !== null && "rest" in value && !("type" in value);
}
function forgivingSelectorRest(children) {
  const parts = [];
  for (const child of children) {
    if (isInterpolation(child)) {
      parts.push(...child.parts);
    } else {
      appendInterpolationLiteral(parts, tokenText(child));
    }
  }
  const last = parts[parts.length - 1];
  if (last !== void 0 && "lit" in last) {
    parts[parts.length - 1] = { lit: last.lit.replace(CSS_TRAILING_WHITESPACE, "") };
  }
  const only = parts.length === 1 ? parts[0] : void 0;
  return { rest: only !== void 0 && "lit" in only ? simpleSelector(only.lit) : interpolatedSimpleSelector(interpolation(parts)) };
}
function forgivingSelectorItem(children, span, triviaLog, state) {
  const prefix = isSelectorBranch(children[0]) ? children[0] : void 0;
  const rest = children.find(isForgivingSelectorRest);
  if (prefix !== void 0 && rest === void 0 && prefix.type !== "RelativeSelector") {
    return withSourceSpan(prefix, span);
  }
  const written = authoredSource(span, state, "A forgiving selector-list item");
  const kept = written.replace(CSS_LEADING_WHITESPACE, "").replace(CSS_TRAILING_WHITESPACE, "");
  const start = span.start + written.length - written.replace(CSS_LEADING_WHITESPACE, "").length;
  const gapped = withTriviaGaps(children, triviaLog);
  const item = withSourceSpan(
    rest === void 0 ? prefix ?? simpleSelector("") : prefix === void 0 ? rest.rest : withRest(prefix, rest.rest, gapped[gapped.indexOf(rest) - 1] === " "),
    { start, end: start + kept.length }
  );
  if (kept !== "") {
    forgivenSelectorItemsOfState(state)?.push({ item, written: kept, recoveredValue: item });
  }
  return item;
}
function withRest(prefix, rest, spaced2) {
  const segments = branchSegments(prefix);
  const last = segments[segments.length - 1];
  if (spaced2) {
    segments.push({ combinator: " ", term: rest });
  } else {
    const [first, ...more] = last.term.type === "CompoundSelector" ? last.term.value : [last.term];
    segments[segments.length - 1] = { ...last, term: selectorTermOf([first, ...more, rest]) };
  }
  if (prefix.type === "RelativeSelector") {
    return relativeSelector(prefix.value[0], segments);
  }
  const [head, second, ...tail] = segments;
  return second === void 0 ? head.term : complexSelector([head, second, ...tail]);
}
function forgivingSelectorList(children, state) {
  const items = children.filter(isSelectorBranch);
  if (items.length > 1) {
    for (const item of items) {
      if (item.type === "SimpleSelector" && item.text === "") {
        forgivenSelectorItemsOfState(state)?.push({ item, written: "", recoveredValue: item });
      }
    }
  }
  return selist(...items);
}
function withForgivenSelectorItems(document, recorded) {
  if (recorded.length > 0) {
    document._forgiven = [...new Map(recoveredInTree(document, recorded).map((entry) => [entry.item, entry])).values()];
  }
  return document;
}
function forgivenSelectorItemsOf(document) {
  return document._forgiven ?? [];
}
function forgivenSelectorItemsOfState(state) {
  const document = typeof state === "object" && state !== null && "document" in state ? state.document : void 0;
  return typeof document === "object" && document !== null && "forgivenSelectorItems" in document && Array.isArray(document.forgivenSelectorItems) ? document.forgivenSelectorItems : void 0;
}
function adoptForgivenSelectorItems(children, capture, state) {
  const recorded = forgivenSelectorItemsOfState(state);
  const list2 = children.find((child) => typeof child === "object" && child !== null && "type" in child && child.type === "SelectorList");
  if (recorded === void 0 || recorded.length === 0 || list2 === void 0) {
    return capture;
  }
  const inList = /* @__PURE__ */ new Set();
  const stack = [list2];
  while (stack.length > 0) {
    const item = stack.pop();
    if (typeof item === "object" && item !== null && !inList.has(item)) {
      inList.add(item);
      stack.push(...Object.values(item));
    }
  }
  for (const entry of recorded) {
    if (inList.has(entry.recoveredValue)) {
      entry.recoveredValue = capture;
    }
  }
  return capture;
}

// packages/core/src/ast/component-run.ts
function componentRun(children, isOperand = isValueSlotValue) {
  const values = [];
  const layout = [];
  let separator = "";
  for (const child of children) {
    if (isOperand(child)) {
      if (values.length > 0) {
        layout.push(separator);
      }
      values.push(child);
      separator = "";
    } else if (isTerminalText(child)) {
      separator += tokenText(child);
    }
  }
  for (let i = 1; i < values.length - 1; i++) {
    if (isOperatorDelim(values[i])) {
      if (layout[i - 1] === "") {
        layout[i - 1] = " ";
      }
      if (layout[i] === "") {
        layout[i] = " ";
      }
    }
  }
  return values.length === 1 ? values[0] : withValueLayout(values, layout);
}
function isOperatorDelim(value) {
  return typeof value === "object" && value !== null && "type" in value && value.type === "Any" && (value.src === "+" || value.src === "-" || value.src === "*");
}

// packages/core/src/ast/paren-group.ts
function parenGroupContent(children, fields) {
  const value = children.find(isValueSlotValue) ?? [];
  if (fields?.separator === void 0) {
    return value;
  }
  const items = !isValueSlotArray2(value) && value.type === "List" && value.sep === "," ? value : list([value], ",");
  return withValueLayout(
    list([...items.value, []], ","),
    [...valueLayoutOf(items) ?? [], ...authoredSeparators(fields)]
  );
}

// packages/core/src/ast/guard-node.ts
var inParens = (guard) => ({ ...guard, parens: guard.parens + 1 });
function isIfTestCall(value) {
  if (!("type" in value) || value.type !== "FunctionCall") {
    return false;
  }
  const name = value.name.toLowerCase();
  return name === "media" || name === "supports" || name === "style";
}
function hasCssTest(node) {
  switch (node.g) {
    case "css":
      return true;
    case "and":
    case "or":
      return hasCssTest(node.left) || hasCssTest(node.right);
    case "not":
      return hasCssTest(node.inner);
    default:
      return false;
  }
}
export {
  AST_NODE_TYPES,
  CSS_MATH_FUNCTIONS,
  CSS_MATH_FUNCTION_OPENERS,
  DeprecatedIfFunctionWarning,
  ERR,
  LeadingSeparatorValueError,
  NO_SPAN,
  NULL_NODE,
  PLACEHOLDER_SIGIL,
  STRUCTURED_PSEUDOS,
  WARN,
  adoptForgivenSelectorItems,
  anPlusB,
  anPlusBFrom,
  anonymousMixin,
  any,
  appendCustomValueParts,
  appendInterpolationLiteral,
  apply,
  asDiagnostic,
  atRuleBlock,
  atRuleStatement,
  attributeSelectorFrom,
  authoredSeparators,
  authoredSource,
  authoredText,
  block,
  blockStatements,
  bodySpanFromRaw,
  bodySpanOf,
  branch,
  branchRest,
  branchSegments,
  branchTextIsPlaceholder,
  callArg,
  chainedQueryComparison,
  classifyValueBlock,
  collection,
  collectionEntry,
  collectionSpread,
  color,
  colorAlphaSlash,
  commaListWithComments,
  comment,
  complexCanonical,
  complexHasAmpersand,
  complexHasInterp,
  complexSegments,
  complexSelector,
  componentRun,
  compoundCanonical,
  compoundHasAmpersand,
  compoundHasInterp,
  compoundSelector,
  compoundSelectorOf,
  condition,
  createTriviaMapFromParseman,
  createTriviaMapFromRanges,
  createTriviaMapFromRootIndex,
  crossable,
  cssBaseMathOutsideParens,
  cssRelativeCombinator,
  customValueFromChildren,
  decl,
  declarationReference,
  delimiterClose,
  delimiterOpen,
  dimension,
  directionKeyword,
  documentStatements,
  enclosedCall,
  enterSupportsGroup,
  expression,
  fallbackCall,
  firstValue,
  flattenSequences,
  foldOperation,
  forNode,
  forgivenSelectorItemsOf,
  forgivingSelectorItem,
  forgivingSelectorList,
  forgivingSelectorRest,
  funcCall,
  functionOpenName,
  generalEnclosedArgument,
  generalEnclosedGroup,
  generalEnclosedSourceOf,
  hasAmbientFunctions,
  hasCssTest,
  ifNode,
  ifTestCall,
  ifValue,
  importIsCompileTime,
  importOptionWords,
  importPrelude,
  importSourceEndOf,
  importSourceStartOf,
  importTailStartOf,
  importTargetSpelling,
  important,
  inParens,
  interpolatedSimpleSelector,
  interpolation,
  interpolationFromTemplateChildren,
  isAnPlusB,
  isAnonymousMixin,
  isAtRuleBlock,
  isAtRuleStatement,
  isComplex,
  isComplexSelector,
  isCompound,
  isConditionOperand,
  isCssColorCall,
  isCssColorFunction,
  isDeclaration,
  isDiagnosticStatement,
  isDocumentStatement,
  isExtendInstruction,
  isFor,
  isForBinding,
  isGeneralEnclosedTemplate,
  isGluedConditionKeyword,
  isGuardNodeOf,
  isIf,
  isIfTestCall,
  isImportTarget,
  isInSupportsGroup,
  isInterpolation,
  isKeyword,
  isLanguageRange,
  isList,
  isLiteralNode,
  isMathFunctionName,
  isMathOperator,
  isMixinCall,
  isMixinDefinition,
  isModuleImport,
  isNode,
  isNodeType,
  isNthArgument,
  isParam,
  isParamArray,
  isQuoted,
  isReference,
  isRelative,
  isRelativeSelector,
  isRuleset,
  isRulesetStatement,
  isSelectorBranch,
  isSelectorList,
  isSelectorTerm,
  isSimple,
  isSimpleToken,
  isSpannedToken,
  isStaticQuoted,
  isStyleImport,
  isTerminalText,
  isToken,
  isTypedLiteral,
  isUnknownAtRuleBlock,
  isValue,
  isValueBlock,
  isValueSlotArray2 as isValueSlotArray,
  isValueSlotOf,
  isValueSlotValue,
  isWhile,
  keyframeSelectorList,
  keyword,
  keywordOrNull,
  languageRangeList,
  list,
  lookupStep,
  makeJessError,
  makeJessErrorFromDiagnostic,
  mixinCall,
  mixinDef,
  moduleImport,
  nestedPropertyBlock,
  nthArgument,
  operation,
  optionalValue,
  parenGroupBlock,
  parenGroupContent,
  parentSelectorReference,
  parserDiagnostic,
  plugin,
  propertyReference,
  pseudoArgumentText,
  pseudoCanonical,
  pseudoHasAmpersand,
  pseudoHasInterp,
  pseudoJoin,
  pseudoSelector,
  queryComparisonOperators,
  queryConditionChain,
  queryFeatureBlock,
  queryFeatureContents,
  queryFeatureNameFrom,
  queryFeatureNameValue,
  queryValueRatio,
  quoted,
  range,
  recoveredInTree,
  reference,
  relativeCanonical,
  relativeHasAmpersand,
  relativeHasInterp,
  relativeSelector,
  renderCombinator,
  requireForBinding,
  requireGuardNodeOf,
  requireInterpolation,
  requireSelectorList,
  requireString,
  requireStructuredPseudo,
  requireToken,
  rule,
  rulesetStatements,
  sassImportUrlIsPlainCss,
  scannedLeaf,
  sel,
  selectorArgumentText,
  selectorBranchCanonical,
  selectorBranchComponents,
  selectorBranchHasAmpersand,
  selectorBranchHasInterp,
  selectorBranchOf,
  selectorBranches,
  selectorCapture,
  selectorCaptureOf,
  selectorCombinator,
  selectorStringComponents,
  selectorTermCanonical,
  selectorTermFromTokens,
  selectorTermHasAmpersand,
  selectorTermHasInterp,
  selectorTermOf,
  selist,
  semanticGapText,
  semanticTextWithTriviaGaps,
  semicolonGroupedCall,
  sepGlue,
  simpleSelector,
  simpleSelectorIsPlaceholder,
  simpleTokenHasInterp,
  simpleTokenText,
  sourceEndOf,
  sourceSpanOf,
  sourceStartOf,
  sourceText,
  spaced,
  structuredPseudoFrom,
  styleFeature,
  styleImport,
  stylesheet,
  supportsDeclaration,
  textHoldsParentRef,
  toDiagnostic,
  tokenText,
  triviaMapOf,
  triviaTextAt,
  unknownAtRuleBlock,
  unknownBodyText,
  url,
  valueBlockBody,
  valueBoundaryTriviaOf,
  valueChildren,
  valueLayoutOf,
  valueSlot,
  valueSlotChildren,
  variableDeclaration,
  variableReference,
  walkAuthoredAst,
  walkAuthoredValue,
  whileNode,
  withAuthoredSeparators,
  withBlockBody,
  withBodySpan,
  withFirstBranchCondition,
  withForgivenSelectorItems,
  withFunctionScope,
  withGeneralEnclosedSource,
  withGeneralEnclosedTemplate,
  withGluedKeywordSpan,
  withImportSourceSpan,
  withImportTailStart,
  withSourceSpan,
  withTriviaGaps,
  withTriviaMap,
  withValueBoundaryTrivia,
  withValueLayout
};
