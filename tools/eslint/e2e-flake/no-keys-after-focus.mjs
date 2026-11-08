/**
 * `no-keys-after-focus`: a key sent the moment after `focus()`, or typing or
 * an editing key the moment after a click, can land before the focus or the
 * caret does (#445, #489, #698, #775).
 *
 * It looks back past statements that await nothing (a `const` naming a
 * locator) to the last one that does, and forward into a loop of keys. It sees
 * `page.keyboard` and a keyboard kept in a variable. A focus inside a helper
 * function the test calls is out of its sight: such a helper should itself
 * wait for the focus, as e2e/typing.ts's do.
 */
import { awaitedCall, awaits, methodName } from './ast.mjs';

const FOCUSING = new Set(['focus']);
const CLICKING = new Set(['click', 'dblclick', 'tap']);
const KEYBOARD = new Set(['press', 'type', 'insertText', 'down']);
const TEXT = new Set(['type', 'insertText']);
/** Keys that move or edit at the caret, so race it as typing does; with any modifiers. */
const EDITING_KEY = /(^|\+)(Backspace|Delete|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|Home|End)$/;
const LOOPS = new Set([
  'ForStatement',
  'ForOfStatement',
  'ForInStatement',
  'WhileStatement',
  'DoWhileStatement',
]);

/** The literal key `call` presses, or null when it is not written out. */
function keyPressed(call) {
  const [key] = call.arguments;
  if (key?.type === 'Literal' && typeof key.value === 'string') return key.value;
  if (key?.type === 'TemplateLiteral' && key.expressions.length === 0)
    return key.quasis[0].value.cooked;
  return null;
}

/** Whether keys `call` sends edit at the caret: typed text, or an editing key. */
function editsAtCaret(call) {
  const method = methodName(call);
  if (TEXT.has(method)) return true;
  const key = keyPressed(call);
  return key !== null && EDITING_KEY.test(key);
}

export const noKeysAfterFocus = {
  meta: {
    type: 'problem',
    schema: [],
    messages: {
      tooSoon:
        'A key pressed right after focus() or a click can land before the focus or the caret does: use focusThenPress, focusThenType or clickThenType from e2e/typing.ts, or caretAtLineEnd / caretAtNoteEnd from e2e/caret.ts in the editor.',
    },
  },
  create(context) {
    // Names that hold a page's keyboard: `page.keyboard`'s own, and any kept in a variable.
    const keyboards = new Set(['keyboard']);
    const lists = [];

    function isKeyboardCall(call) {
      if (!KEYBOARD.has(methodName(call))) return false;
      const on = call.callee.object;
      if (on.type === 'Identifier') return keyboards.has(on.name);
      return (
        on.type === 'MemberExpression' &&
        !on.computed &&
        on.property.type === 'Identifier' &&
        on.property.name === 'keyboard'
      );
    }

    /** The first keyboard call `statement` makes, looking into a loop's body, or null. */
    function firstKeys(statement) {
      if (statement === undefined) return null;
      if (LOOPS.has(statement.type)) {
        const { body } = statement;
        return firstKeys(body.type === 'BlockStatement' ? body.body[0] : body);
      }
      const call = awaitedCall(statement);
      return call !== null && isKeyboardCall(call) ? call : null;
    }

    function tooSoon(before, keys) {
      const moved = methodName(awaitedCall(before));
      if (FOCUSING.has(moved)) return true;
      return CLICKING.has(moved) && editsAtCaret(keys);
    }

    function check(statements) {
      for (let at = 1; at < statements.length; at += 1) {
        const keys = firstKeys(statements[at]);
        if (keys === null) continue;
        let back = at - 1;
        while (back >= 0 && !awaits(statements[back])) back -= 1;
        if (back >= 0 && tooSoon(statements[back], keys))
          context.report({ node: statements[at], messageId: 'tooSoon' });
      }
    }

    return {
      VariableDeclarator(node) {
        const { id, init } = node;
        if (id.type === 'Identifier' && init?.type === 'MemberExpression') {
          if (!init.computed && init.property.name === 'keyboard') keyboards.add(id.name);
        }
        if (id.type !== 'ObjectPattern') return;
        for (const property of id.properties) {
          const named = property.type === 'Property' && property.key.name === 'keyboard';
          if (named && property.value.type === 'Identifier') keyboards.add(property.value.name);
        }
      },
      Program: (node) => lists.push(node.body),
      BlockStatement: (node) => lists.push(node.body),
      SwitchCase: (node) => lists.push(node.consequent),
      // At the end, once every keyboard kept in a variable is known.
      'Program:exit': () => lists.forEach(check),
    };
  },
};
