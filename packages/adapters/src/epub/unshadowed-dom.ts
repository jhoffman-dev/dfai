/*
 * The DOM's own members, read once before any chapter is parsed or built
 * (#505, ADR-0045). An HTML document's named properties shadow its own
 * members — a book's `<img name="createRange">` makes `document.createRange`
 * that picture — and a form's controls do the same to the form by their name
 * or id (DOM clobbering). The reader's cleaning and the frame's script call
 * these instead, on the node they act on, so no name a book writes stands in
 * for them; and both drop a name or id that would shadow a member, so a
 * book's document keeps its own.
 *
 * This file is part of the frame's script (tools/epub/frame-bootstrap.ts), so
 * it imports nothing; run there, it reads the frame's own prototypes as the
 * script starts. Where there is no DOM at all (a test in Node) nothing is
 * read, and calling any of these throws.
 */

const XHTML_NS = 'http://www.w3.org/1999/xhtml';

/** HTML elements a document or a form takes as a member by their `name` or `id`. */
const NAMED_MEMBERS = new Set([
  'button',
  'embed',
  'fieldset',
  'form',
  'iframe',
  'img',
  'input',
  'object',
  'output',
  'select',
  'textarea',
]);

type Getter<T, V> = (this: T) => V;

function getterOf<T, V>(prototype: object, name: string): Getter<T, V> {
  const get = Object.getOwnPropertyDescriptor(prototype, name)?.get;
  if (get === undefined) throw new Error(`the DOM has no ${name}`);
  return get as Getter<T, V>;
}

/**
 * `name` as `target`'s prototypes define it, never as the target itself
 * does: a document's or a form's named properties are its own, so they are
 * passed over. For the members some DOMs lack (jsdom), read when used.
 */
function inheritedMember(target: object, name: string): PropertyDescriptor {
  for (let at = Object.getPrototypeOf(target) as object | null; at !== null;) {
    const found = Object.getOwnPropertyDescriptor(at, name);
    if (found !== undefined) return found;
    at = Object.getPrototypeOf(at) as object | null;
  }
  throw new Error(`the DOM has no ${name}`);
}

/** Each member read off its prototype, to be called with `.call` on the node it acts on. */
function readOwnMembers() {
  const doc = Document.prototype;
  const node = Node.prototype;
  const element = Element.prototype;
  return {
    documentMembers: doc as object,
    formMembers: HTMLFormElement.prototype as object,
    createRange: doc.createRange,
    getElementById: doc.getElementById,
    querySelector: doc.querySelector as (this: Document, selectors: string) => Element | null,
    getElementsByTagName: doc.getElementsByTagName as (
      this: Document,
      name: string,
    ) => HTMLCollectionOf<Element>,
    getElementsByTagNameNS: doc.getElementsByTagNameNS as (
      this: Document,
      namespace: string | null,
      name: string,
    ) => HTMLCollectionOf<Element>,
    body: getterOf<Document, HTMLElement | null>(doc, 'body'),
    createTextNode: doc.createTextNode,
    createElementNS: doc.createElementNS as (
      this: Document,
      namespace: string | null,
      name: string,
    ) => Element,
    documentElement: getterOf<Document, Element | null>(doc, 'documentElement'),
    nodeType: getterOf<Node, number>(node, 'nodeType'),
    ownerDocument: getterOf<Node, Document | null>(node, 'ownerDocument'),
    childNodes: getterOf<Node, NodeListOf<ChildNode>>(node, 'childNodes'),
    appendChild: node.appendChild as (this: Node, child: Node) => Node,
    replaceChild: node.replaceChild as (this: Node, child: Node, old: Node) => Node,
    localName: getterOf<Element, string>(element, 'localName'),
    namespaceURI: getterOf<Element, string | null>(element, 'namespaceURI'),
    getAttribute: element.getAttribute,
    setAttribute: element.setAttribute,
    setAttributeNS: element.setAttributeNS,
    removeAttribute: element.removeAttribute,
    closest: element.closest as (this: Element, selectors: string) => Element | null,
  };
}

const ownMembers = typeof Document === 'undefined' ? null : readOwnMembers();

function own(): NonNullable<typeof ownMembers> {
  if (ownMembers === null) throw new Error('there is no DOM here');
  return ownMembers;
}

export const createRange = (doc: Document): Range => own().createRange.call(doc);
export const getElementById = (doc: Document, id: string): Element | null =>
  own().getElementById.call(doc, id);
export const querySelector = (doc: Document, selectors: string): Element | null =>
  own().querySelector.call(doc, selectors);
export const getElementsByTagName = (doc: Document, name: string): HTMLCollectionOf<Element> =>
  own().getElementsByTagName.call(doc, name);
export const getElementsByTagNameNS = (
  doc: Document,
  namespace: string | null,
  name: string,
): HTMLCollectionOf<Element> => own().getElementsByTagNameNS.call(doc, namespace, name);
export const bodyOf = (doc: Document): HTMLElement | null => own().body.call(doc);
export const createTextNode = (doc: Document, text: string): Text =>
  own().createTextNode.call(doc, text);
export const createElementNS = (doc: Document, namespace: string | null, name: string): Element =>
  own().createElementNS.call(doc, namespace, name);
export const documentElementOf = (doc: Document): Element | null => own().documentElement.call(doc);
export function setAdoptedStyleSheets(doc: Document, sheets: CSSStyleSheet[]): void {
  const set = inheritedMember(doc, 'adoptedStyleSheets').set;
  if (set === undefined) throw new Error('the DOM cannot set adoptedStyleSheets');
  set.call(doc, sheets);
}
export const nodeTypeOf = (node: Node): number => own().nodeType.call(node);
export const ownerDocumentOf = (node: Node): Document | null => own().ownerDocument.call(node);
export const childNodesOf = (node: Node): NodeListOf<ChildNode> => own().childNodes.call(node);
export const appendChild = (parent: Node, child: Node): Node =>
  own().appendChild.call(parent, child);
export const replaceChild = (parent: Node, child: Node, old: Node): Node =>
  own().replaceChild.call(parent, child, old);
export const localNameOf = (element: Element): string => own().localName.call(element);
export const namespaceOf = (element: Element): string | null => own().namespaceURI.call(element);
export const getAttribute = (element: Element, name: string): string | null =>
  own().getAttribute.call(element, name);
export const setAttribute = (element: Element, name: string, value: string): void =>
  own().setAttribute.call(element, name, value);
export const setAttributeNS = ({
  element,
  namespace,
  name,
  value,
}: {
  element: Element;
  namespace: string | null;
  name: string;
  value: string;
}): void => own().setAttributeNS.call(element, namespace, name, value);
export const removeAttribute = (element: Element, name: string): void =>
  own().removeAttribute.call(element, name);
export const closest = (element: Element, selectors: string): Element | null =>
  own().closest.call(element, selectors);
export function scrollIntoView(element: Element, options: ScrollIntoViewOptions): void {
  const scroll: unknown = inheritedMember(element, 'scrollIntoView').value;
  if (typeof scroll !== 'function') throw new Error('the DOM cannot scroll an element into view');
  (scroll as Element['scrollIntoView']).call(element, options);
}

/**
 * Whether `attribute` (`name` or `id`) set to `value` on `element` would
 * shadow a member of its document or its form: `<img name="body">`, `<input
 * name="appendChild">`. Only the elements a document or form takes by name
 * can; a `<p id="title">` or an `<a name="top">` shadows nothing and keeps
 * its place as a link's target.
 */
export function shadowsAMember(element: Element, attribute: string, value: string): boolean {
  const name = attribute.toLowerCase();
  if (name !== 'name' && name !== 'id') return false;
  const members = own();
  if (members.namespaceURI.call(element) !== XHTML_NS) return false;
  if (!NAMED_MEMBERS.has(members.localName.call(element).toLowerCase())) return false;
  return value in members.documentMembers || value in members.formMembers;
}
