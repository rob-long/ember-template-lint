import { builders as b } from 'ember-template-recast';

import createErrorMessage from '../helpers/create-error-message.js';
import isValidConfigObjectFormat from '../helpers/is-valid-config-object.js';
import replaceNode from '../helpers/replace-node.js';
import Rule from './_base.js';

const ERROR_MESSAGE = 'Your config does not match the allowed values';

// The parts of an ElementNode or MustacheStatement that this rule is concerned with
// These are also nodes themselves
const TokenType = {
  ARGUMENTS: 'arguments',
  ATTRIBUTES: 'attributes',
  MODIFIERS: 'modifiers',
  SPLATTRIBUTES: 'splattributes',
  COMMENTS: 'comments',
};

const DEFAULT_CONFIG = {
  alphabetize: true,
  order: [TokenType.ARGUMENTS, TokenType.ATTRIBUTES, TokenType.MODIFIERS],
};

export function createAttributesOrderErrorMessage(config) {
  return createErrorMessage('attribute-order', ERROR_MESSAGE, config);
}

// Class representing all of attribute tokens of a given tokenType for a node
class TokenGroup {
  _type;
  _items;
  _context;

  constructor(type, items, context) {
    this._type = type;
    this._items = items;
    this._context = context;
  }

  // the tokenType for the group
  get type() {
    return this._type;
  }

  // all of the nodes belonging to the tokenGroup
  get items() {
    return this._items;
  }

  get exists() {
    return this.items.length > 0;
  }

  // indexes of the nodes belonging to the tokenGroup
  get indexes() {
    return this.items.map((node) => this._context.calculateAttributeIndex(node));
  }

  get indexesWithNode() {
    return this.items.map((node) => {
      return { node: node.name || node.value, index: this._context.calculateAttributeIndex(node) };
    });
  }

  // the largest index of the tokenGroup
  get lastIndex() {
    return this.indexes.length ? Math.max(...this.indexes) : undefined;
  }

  // the smallest index of the tokenGroup
  get firstIndex() {
    return this.indexes.length ? Math.min(...this.indexes) : undefined;
  }

  // the first unalphabetized node of the tokenGroup
  get unalphabetizedItemIndex() {
    const alpha = this.items.map((attr) => {
      return this._context.sourceForNode(attr).match(/([^A-Za-z]*)([\w-]*)/)[2];
    });
    return alpha.findIndex((e, idx) => idx > 0 && e < alpha[idx - 1]);
  }
}

export default class AttributeOrder extends Rule {
  appliedOrder = undefined;
  tokenGroups = undefined;

  parseConfig(config) {
    const errorMessage = createAttributesOrderErrorMessage(config);
    if (!isValidConfigObjectFormat(config, DEFAULT_CONFIG)) {
      throw new Error(errorMessage);
    }

    if (config === false) {
      return false;
    }

    if (typeof config === 'object') {
      if (
        config.order &&
        ![TokenType.ARGUMENTS, TokenType.ATTRIBUTES, TokenType.MODIFIERS].every((attribute) =>
          config.order.includes(attribute)
        )
      ) {
        throw new Error(errorMessage);
      }
      return { ...DEFAULT_CONFIG, ...config };
    }

    return DEFAULT_CONFIG;
  }

  /**
   *
   * @param {object} tokenGroups
   * @returns {boolean} True if splattributes are surrounded/enclosed by tokens on the left and right
   * When surrounded, the ordering relative to splattributes must remain intact which prevents this rule from auto-fixing.
   */
  areSplattributesSurrounded() {
    const splattributeLastIndex = this.tokenGroups[TokenType.SPLATTRIBUTES].lastIndex;
    if (splattributeLastIndex < 0) {
      return false;
    }
    const maxIndex = Math.max(
      ...Object.values(this.tokenGroups).map(
        (tokenGroup) => tokenGroup.lastIndex || Number.NEGATIVE_INFINITY
      )
    );
    const minIndex = Math.min(
      ...Object.values(this.tokenGroups).map(
        (tokenGroup) => tokenGroup.firstIndex || Number.POSITIVE_INFINITY
      )
    );
    return splattributeLastIndex > minIndex && splattributeLastIndex < maxIndex;
  }

  /**
   *
   * @param {object} node
   * @returns {number} A number representing the relative location of the node
   */
  calculateAttributeIndex(node) {
    return node.loc.start.line * node.loc.start.column;
  }

  /**
   *
   * @param {TokenType} tokenType
   * @returns {number} Index representing the order in which a tokenType should be sorted
   */
  getOrder(tokenType) {
    return this.getAppliedOrder().indexOf(tokenType);
  }

  /**
   *
   * @returns {array} The order of attributes given a particular node
   * If splattributes are in the first or last position they should remain in that order
   */
  getAppliedOrder() {
    if (this.appliedOrder) {
      return this.appliedOrder;
    }
    const maxLastIndex = Math.max(
      ...Object.values(this.tokenGroups)
        .map((tokenGroup) => tokenGroup.lastIndex)
        .filter((i) => Number.isInteger(i))
    );
    const minLastIndex = Math.min(
      ...Object.values(this.tokenGroups)
        .map((tokenGroup) => tokenGroup.lastIndex)
        .filter((i) => Number.isInteger(i))
    );

    const orderMinusSplattributes = [
      ...this.config.order.filter((attribute) => attribute !== TokenType.SPLATTRIBUTES),
    ];

    const splattributeLastIndex = this.tokenGroups[TokenType.SPLATTRIBUTES]
      ? this.tokenGroups[TokenType.SPLATTRIBUTES].lastIndex
      : undefined;
    const attributeLastIndex = this.tokenGroups[TokenType.ATTRIBUTES]
      ? this.tokenGroups[TokenType.ATTRIBUTES].lastIndex
      : undefined;

    if (
      splattributeLastIndex === maxLastIndex ||
      (splattributeLastIndex && splattributeLastIndex > attributeLastIndex)
    ) {
      this.appliedOrder = [...orderMinusSplattributes, TokenType.SPLATTRIBUTES];
    } else if (
      splattributeLastIndex === minLastIndex ||
      (splattributeLastIndex && splattributeLastIndex < attributeLastIndex)
    ) {
      this.appliedOrder = [TokenType.SPLATTRIBUTES, ...orderMinusSplattributes];
    } else {
      this.appliedOrder = [...orderMinusSplattributes, TokenType.SPLATTRIBUTES];
    }
    return this.appliedOrder;
  }

  /**
   *
   * @param {object} node
   * @param {string} nodeText
   * @returns {array} All possible tokens.  Mustache statements can only contain attributes.
   */
  getMustacheStatementTokens(node) {
    const keys = [];
    for (const attr of node.hash.pairs) {
      keys.push([TokenType.ATTRIBUTES, attr]);
    }
    return keys;
  }

  /**
   *
   * @param {object} node
   * @param {string} nodeText
   * @returns {array} All possible tokens.  Mustache statements can only contain attributes.
   */
  getElementNodeTokens(node) {
    const keys = [];
    for (const attr of node.attributes) {
      const type = this.getTokenType(attr);
      keys.push([type, attr]);
    }
    for (const modifier of node.modifiers) {
      keys.push([TokenType.MODIFIERS, modifier]);
    }
    for (const comment of node.comments) {
      keys.push([TokenType.COMMENTS, comment]);
    }
    return keys;
  }

  /**
   *
   * @param {string} tokenType
   * @returns {string} Categorical type (either attributes or modifiers) of the attribute.
   * Arguments, attributes and splattributes are considered attributes.
   */
  getTokenCategory(tokenType) {
    return [TokenType.ARGUMENTS, TokenType.ATTRIBUTES, TokenType.SPLATTRIBUTES].includes(tokenType)
      ? TokenType.ATTRIBUTES
      : tokenType;
  }

  /**
   *
   * @param {object} node
   * @returns The specific type of token (arguments, splattributes, attributes or modifiers) which can be ordered.
   */
  getTokenType(node) {
    if (node.type && node.type.includes('Comment')) {
      return TokenType.COMMENTS;
    }
    if (!node.name) {
      return TokenType.MODIFIERS;
    }
    return node.name.startsWith('@')
      ? TokenType.ARGUMENTS
      : node.name.startsWith('...')
      ? TokenType.SPLATTRIBUTES
      : TokenType.ATTRIBUTES;
  }

  /**
   *
   * @param {object} config
   * @returns Matching node based on config values from tokenGroups
   */
  getNode({ type, name, value }) {
    for (const tokenGroup of Object.values(this.tokenGroups)) {
      const items = tokenGroup.items;
      for (const node of items) {
        if (node.type === type && ((node.name && node.name === name) || node.value === value)) {
          return node;
        }
      }
    }
  }

  /**
   *
   * @param {object} node
   * @param {object} config
   * @returns Matching node based on config values from tokenGroups
   */
  makeToken({ nodeType, node, loc }) {
    switch (nodeType) {
      case TokenType.MODIFIERS:
        return b.elementModifier(b.path(node.path), node.params, node.hash, loc);

      case TokenType.COMMENTS:
        return node.type === 'MustacheCommentStatement'
          ? b.mustacheComment(node.value, loc)
          : b.comment(node.value, loc);

      default:
        return b.attr(node.name, node.value, loc);
    }
  }

  /**
   *
   * @param {object} node
   * @param {object} config
   * @returns {node} Matching node based on config values from tokenGroups
   */
  groupTokens(tokens) {
    const result = Object.values(TokenType).reduce((acc, tokenType) => {
      acc[tokenType] = [];
      return acc;
    }, {});
    for (let [tokenType, node] of tokens) {
      result[tokenType].push(node);
    }
    return result;
  }

  /**
   *
   * @param {object} tokens
   * @returns {object} Object keyed by TokenType each containing a TokenGroup
   */
  makeTokenGroups(tokens) {
    const tokenGroups = {};
    for (const tokenType of Object.keys(tokens)) {
      tokenGroups[tokenType] = new TokenGroup(tokenType, tokens[tokenType], this);
    }
    this.tokenGroups = tokenGroups;
    return tokenGroups;
  }

  /**
   *
   * @returns {array} sorted list of all the indexes of each token in tokenGroups
   */
  getAllIndexes() {
    let mergedIndexes = [];
    for (const tokenType of Object.keys(this.tokenGroups)) {
      const indexes = this.tokenGroups[tokenType].indexes;
      mergedIndexes = [...mergedIndexes, ...indexes];
    }
    return [...mergedIndexes].sort((a, b) => a - b);
  }

  /**
   *
   * @param {string} tokenType
   * @param {TokenGroup} tokenGroup
   * @returns {object} node The first token that is unalphabetized
   */
  findUnalphabetizedToken(tokenGroup) {
    return tokenGroup.items[tokenGroup.unalphabetizedItemIndex];
  }

  /**
   *
   * @param {object} tokenGroup
   * @returns {array} sorted list of all the indexes of each token in tokenGroups
   */
  findUnorderedToken(tokenGroup) {
    return tokenGroup.items.find(
      (item) => this.calculateAttributeIndex(item) === tokenGroup.lastIndex
    );
  }

  capitalizedAttribute(string) {
    return string[0].toUpperCase() + string.slice(1, -1);
  }

  createNotAlphabetizedErrorMessage(tokenType, source) {
    return `${this.capitalizedAttribute(tokenType)} ${source} is not alphabetized`;
  }

  createUnorderedErrorMessage(tokenType, source) {
    const order = this.getOrder(tokenType);
    if (order === 0) {
      const otherAttributes = `${this.getAppliedOrder()[1]} and ${this.getAppliedOrder()[2]}`;

      return `${this.capitalizedAttribute(tokenType)} ${source} must go before ${otherAttributes}`;
    }
    if (order === 1) {
      return `${this.capitalizedAttribute(tokenType)} ${source} must go after ${
        this.config.order[order - 1]
      }`;
    }
    return `${this.capitalizedAttribute(tokenType)} ${source} must go after ${
      this.getAppliedOrder()[order - 1]
    }`;
  }

  /**
   *
   * There are four possible types of attributes.
   *
   * A given tokenType in the first position is unordered if the lastIndex
   * greater than the lastIndex of all of the other attributes.
   *
   * A given tokenType in the third position is unordered if the lastIndex is
   * less than the lastIndex of the tokenType in the second position.
   *
   * A given tokenType in the fourth position is unordered if the lastIndex is
   * less than than the lastIndex of the tokenType in the third position.
   *
   * @param {string} tokenType
   * @returns {boolean} true if the type of attribute is out of order according to the `order`
   */
  isAttributeUnordered(tokenType) {
    const order = this.getOrder(tokenType);
    if (!this.tokenGroups[tokenType].exists) {
      return false;
    }
    if (this.areSplattributesSurrounded()) {
      return false;
    }

    switch (order) {
      case 0:
        return (
          this.tokenGroups[tokenType].lastIndex >
            this.tokenGroups[this.getAppliedOrder()[1]].firstIndex ||
          this.tokenGroups[tokenType].lastIndex >
            this.tokenGroups[this.getAppliedOrder()[2]].firstIndex ||
          this.tokenGroups[tokenType].lastIndex >
            this.tokenGroups[this.getAppliedOrder()[3]].firstIndex
        );

      case 1:
        return (
          this.tokenGroups[tokenType].lastIndex <
            this.tokenGroups[this.getAppliedOrder()[0]].firstIndex ||
          this.tokenGroups[tokenType].lastIndex >
            this.tokenGroups[this.getAppliedOrder()[2]].firstIndex
        );

      case 2:
        return (
          this.tokenGroups[tokenType].lastIndex <
            this.tokenGroups[this.getAppliedOrder()[1]].lastIndex ||
          this.tokenGroups[tokenType].lastIndex >
            this.tokenGroups[this.getAppliedOrder()[3]].lastIndex
        );

      case 3:
        return (
          this.tokenGroups[tokenType].lastIndex <
          this.tokenGroups[this.getAppliedOrder()[2]].lastIndex
        );

      default:
        break;
    }
  }

  /**
   *
   * Check if mustacheStatement requires alphabetization of tokens.
   * A mustacheStatement only contains tokens thus it can only be unordered if it's tokens are not alphabetized.
   * Fix if possible.
   *
   * @param {object} node
   * @returns void
   */
  checkMustacheAttributesOrder(node) {
    if (!this.sourceForNode(node) || node.path.type !== 'PathExpression') {
      return;
    }
    console.log('why here', node);
    const tokenGroups = this.makeTokenGroups(
      this.groupTokens(this.getMustacheStatementTokens(node, this.sourceForNode(node)))
    );
    const tokenGroup = tokenGroups[TokenType.ATTRIBUTES];
    if (this.config.alphabetize && tokenGroup.unalphabetizedItemIndex >= 0) {
      const item = this.findUnalphabetizedToken(tokenGroup);

      if (this.mode === 'fix') {
        node.hash.pairs.sort((a, b) => (a.key > b.key ? 1 : -1));
      } else {
        this.log({
          message: this.createNotAlphabetizedErrorMessage(
            TokenType.ATTRIBUTES,
            this.sourceForNode(item)
          ),
          isFixable: true,
          node: item,
        });
      }
    }
  }

  /**
   *
   * Check if elementNode requires alphabetization or ordering of tokens.
   * Fix if possible.
   *
   * @param {object} node
   * @param {object} object with keys parentNode and parentKey
   * @returns void
   */
  checkElementAttributesOrder(node, { parentNode, parentKey }) {
    if (!this.sourceForNode(node)) {
      return;
    }

    this.makeTokenGroups(
      this.groupTokens(this.getElementNodeTokens(node, this.sourceForNode(node)))
    );
    for (const tokenType of this.config.order) {
      const isAttributeUnalphabetized = Object.values(this.tokenGroups).some((tokenGroup) => {
        return tokenGroup.type !== TokenType.COMMENTS && this.findUnalphabetizedToken(tokenGroup);
      });
      if (
        this.config.alphabetize &&
        isAttributeUnalphabetized &&
        !this.areSplattributesSurrounded()
      ) {
        this.alphabetizeAttribute({ tokenType, node, parentNode, parentKey });
      }

      const isAttributeUnordered = this.isAttributeUnordered(tokenType);
      if (isAttributeUnordered) {
        this.orderAttribute({ tokenType, node, parentNode, parentKey });
      }
    }
  }

  /**
   *
   * Replace existing elementNode with a new elementNode.
   * Within each attribute type, alphabetize the name or path (for modifiers)
   * before making the elementNode.
   * Attrs consist of a grouping of arguments, attributes and splattributes.
   * Modifiers only consist of modifiers.
   *
   * @param {object} Data structure of the relevant node parts required to alphabetize all of the attribute tokens alphabetically
   */
  alphabetizeAttribute({ tokenType, node, parentNode, parentKey }) {
    const item = this.findUnalphabetizedToken(this.tokenGroups[tokenType]);
    if (!item) {
      return;
    }
    if (this.mode === 'fix') {
      const attrs = node[TokenType.ATTRIBUTES]
        .sort((a, b) => {
          if (a.name === '...attributes') {
            return this.getOrder(TokenType.SPLATTRIBUTES) === 3 ? 1 : -1;
          } else if (a.name > b.name) {
            return 1;
          } else {
            return -1;
          }
        })
        .map((attr) => b.attr(attr.name, attr.value));
      const modifiers = node[TokenType.MODIFIERS]
        .sort((a, b) => (a.path.original > b.path.original ? 1 : -1))
        .map((node) => b.elementModifier(b.path(node.path), node.params, node.hash));

      const newNode = b.element(node.tag, {
        attrs,
        modifiers,
        children: node.children,
        blockParams: node.blockParams,
        comments: node.comments,
      });
      newNode.selfClosing = node.selfClosing;

      const comments = [...node[TokenType.COMMENTS]];
      let sorted = [...newNode[TokenType.ATTRIBUTES], ...newNode[TokenType.MODIFIERS], ...comments];
      console.log('ALPHABET');
      this.replaceNode({ node, sorted, parentNode, parentKey });

      if (comments.length) {
        console.log(
          'calling',
          sorted.map((node) => [node.name || node.value, JSON.stringify(node.loc)])
        );
        sorted = this.orderComment({ node, sorted });
      }
      this.replaceNode({ node, sorted, parentNode, parentKey });
    } else {
      this.log({
        message: this.createNotAlphabetizedErrorMessage(tokenType, this.sourceForNode(item)),
        isFixable: true,
        node: item,
      });
    }
  }

  // Mutates sorted. Loop through comments in sorted array of tokens and move to
  // the same position relative to the next token in original order.
  orderComment({ node, sorted }) {
    const reverseComments = node[TokenType.COMMENTS].sort((a, b) => {
      return this.calculateAttributeIndex(b) - this.calculateAttributeIndex(a);
    });
    console.log('order comment start with sorted', sorted);
    console.log('start with reversed comments', reverseComments);

    while (reverseComments.length) {
      const comment = reverseComments.shift();
      const token = this.getNode(comment);
      const fromOrder = this.getAllIndexes().indexOf(this.calculateAttributeIndex(token));
      console.log('N', this.sourceForNode(node));
      console.log(
        'tokengroup',
        Object.values(this.tokenGroups).map((tokenGroup) => tokenGroup.indexesWithNode)
      );
      console.log('working on', comment.value, 'at order', fromOrder);
      const indexOfNext = this.getAllIndexes()[fromOrder + 1];
      console.log({ indexOfNext });
      let toPosInSorted;
      if (fromOrder === this.getAllIndexes.length - 1) {
        toPosInSorted = fromOrder;
        console.log('keep as trailing comment');
      } else {
        toPosInSorted = sorted.findIndex((node) => {
          // indexOfNext will be undefined for trailing comments
          return indexOfNext && this.calculateAttributeIndex(node) === indexOfNext;
        });
      }
      if (toPosInSorted < 0) {
        console.log('didnt find next from all', this.getAllIndexes(), 'at', fromOrder + 1);
        console.log(
          '++',
          sorted.map((node) => [node.name || node.value, JSON.stringify(node.loc)])
        );
        //reverseComments.push(comment);
      } else {
        console.log('put comment at', { toPosInSorted });
        sorted.splice(toPosInSorted, 0, token);
      }
    }

    return sorted;
  }

  /**
   *
   * Replace existing elementNode with a new elementNode with ordered tokens.
   * Order types of tokens according to the configurable `order`.
   *
   * The ordering strategy involves sorting all of the tokens by the `order` for it's tokenType.
   * If the `order` is the same, then the tokens should be left in the same order as before.
   * When creating the tokens, start with element's initial loc and add the length of each new token.
   * Multi-line elements are thus flattened to single line elements.
   *
   * @param {object} Data structure of the relevant node parts required to alphabetize all of the tokens alphabetically
   */
  orderAttribute({ tokenType, node, parentNode, parentKey }) {
    const item = this.findUnorderedToken(this.tokenGroups[tokenType]);

    if (this.mode === 'fix') {
      const attributesModifiers = [...node[TokenType.ATTRIBUTES], ...node[TokenType.MODIFIERS]];
      let sorted = attributesModifiers.sort((a, b) => {
        const orderA = this.getOrder(this.getTokenType(a));
        const orderB = this.getOrder(this.getTokenType(b));
        if (orderA === orderB) {
          if (a.loc && b.loc) {
            return this.calculateAttributeIndex(a) > this.calculateAttributeIndex(b);
          }
        }
        return orderA > orderB ? 1 : -1;
      });

      if (node[TokenType.COMMENTS].length) {
        sorted = this.orderComment({ node, sorted });
      }

      console.log('ORDER');
      this.replaceNode({ node, sorted, parentNode, parentKey });
    } else {
      this.log({
        message: this.createUnorderedErrorMessage(tokenType, this.sourceForNode(item)),
        isFixable: true,
        node: item,
      });
    }
  }

  replaceNode({ node, sorted, parentNode, parentKey }) {
    const minColumn = node.tag.length + 2;
    const { attributes, modifiers, comments } = sorted.reduce((acc, currAttr) => {
      const nodeType = this.getTokenCategory(this.getTokenType(currAttr));
      if (!acc[nodeType]) {
        acc[nodeType] = [];
      }
      const line = node.loc.start.line;
      const startColumn = acc.cursor || minColumn;
      const endColumn = startColumn + currAttr.loc.end.column - currAttr.loc.start.column;
      const loc = b.loc(line, startColumn, line, endColumn);
      const newAttribute = this.makeToken({ nodeType, node: currAttr, loc });
      if (newAttribute.type === 'AttrNode') {
        newAttribute.isValueless = currAttr.isValueless;
        newAttribute.quoteType = currAttr.quoteType;
      }
      acc[nodeType].push(newAttribute);
      acc.cursor = endColumn + 2;
      return acc;
    }, {});

    const newNode = b.element(node.tag, {
      attrs: attributes,
      modifiers,
      children: node.children,
      blockParams: node.blockParams,
      comments,
    });
    newNode.selfClosing = node.selfClosing;

    console.log('sorted', sorted);
    // console.log(
    //   'replacebefore',
    //   Object.values(this.tokenGroups).map((tokenGroup) => tokenGroup.indexesWithNode)
    // );
    replaceNode(node, parentNode, parentKey, newNode);
    // console.log('new node', newNode);
    // this.makeTokenGroups(
    //   this.groupTokens(this.getElementNodeTokens(newNode, this.sourceForNode(newNode)))
    // );
    // console.log(
    //   'replaceafter',
    //   Object.values(this.tokenGroups).map((tokenGroup) => tokenGroup.indexesWithNode)
    // );
  }

  visitor() {
    return {
      MustacheStatement(node) {
        //console.log('start check mustache', node);
        this.checkMustacheAttributesOrder(node);
        //console.log('end mustache');
      },
      ElementNode(node, { parentNode, parentKey }) {
        //console.log('start check element attribute order', node);
        this.checkElementAttributesOrder(node, { parentNode, parentKey });
        //console.log('end element');
      },
    };
  }
}
