import * as ts from "typescript";
import * as fs from "fs";
import * as pathPlatformDependent from "path";
const path = pathPlatformDependent.posix; // This works everythere, just use forward slashes
import * as evalNode from "./evalNode";
import * as spriter from "./spriter";
import * as imageOps from "./imageOps";
import * as imgCache from "./imgCache";
require('bluebird');

export interface SourceInfo {
    sourceFile: ts.SourceFile;
    // module name, module main file
    sourceDeps: [string, string][];
    bobrilNamespace: string;
    bobrilImports: { [name: string]: string };
    bobrilG11NNamespace: string;
    bobrilG11NImports: { [name: string]: string };
    styleDefs: StyleDefInfo[];
    sprites: SpriteInfo[];
    trs: TranslationMessage[];
}

export interface StyleDefInfo {
    callExpression: ts.CallExpression;
    isEx: boolean;
    name?: string;
    userNamed: boolean;
}

export interface SpriteInfo {
    callExpression: ts.CallExpression;
    name?: string;
    color?: string;
    x?: number;
    y?: number;
    width?: number;
    height?: number;
}

export interface TranslationMessage {
    callExpression: ts.CallExpression;
    message: string | number;
    withParams: boolean;
    knownParams?: string[];
    hint?: string;
}

function isBobrilFunction(name: string, callExpression: ts.CallExpression, sourceInfo: SourceInfo): boolean {
    let text = callExpression.expression.getText();
    return text === sourceInfo.bobrilNamespace + '.' + name || text === sourceInfo.bobrilImports[name];
}

function isBobrilG11NFunction(name: string, callExpression: ts.CallExpression, sourceInfo: SourceInfo): boolean {
    let text = callExpression.expression.getText();
    return text === sourceInfo.bobrilG11NNamespace + '.' + name || text === sourceInfo.bobrilG11NImports[name];
}

function extractBindings(bindings: ts.NamespaceImport | ts.NamedImports, ns: string, ims: Object): string {
    if (bindings.kind === ts.SyntaxKind.NamedImports) {
        let namedBindings = <ts.NamedImports>bindings;
        for (let i = 0; i < namedBindings.elements.length; i++) {
            let binding = namedBindings.elements[i];
            ims[(binding.propertyName || binding.name).text] = binding.name.text;
        }
    } else if (ns == null && bindings.kind === ts.SyntaxKind.NamespaceImport) {
        return (<ts.NamespaceImport>bindings).name.text;
    }
    return ns;
}

export function gatherSourceInfo(source: ts.SourceFile, tc: ts.TypeChecker, resolvePathStringLiteral: (sl: ts.StringLiteral) => string): SourceInfo {
    let result: SourceInfo = {
        sourceFile: source,
        sourceDeps: [],
        bobrilNamespace: null,
        bobrilImports: Object.create(null),
        bobrilG11NNamespace: null,
        bobrilG11NImports: Object.create(null),
        sprites: [],
        styleDefs: [],
        trs: []
    };
    function visit(n: ts.Node) {
        if (n.kind === ts.SyntaxKind.ImportDeclaration) {
            let id = <ts.ImportDeclaration>n;
            let moduleSymbol = tc.getSymbolAtLocation(id.moduleSpecifier);
            let fn = moduleSymbol.valueDeclaration.getSourceFile().fileName;
            let bindings = id.importClause.namedBindings;
            if (/bobril\/index\.ts/i.test(fn)) {
                result.bobrilNamespace = extractBindings(bindings, result.bobrilNamespace, result.bobrilImports);
            } else if (/bobril-g11n\/index\.ts/i.test(fn)) {
                result.bobrilG11NNamespace = extractBindings(bindings, result.bobrilG11NNamespace, result.bobrilG11NImports);
            }
            result.sourceDeps.push([moduleSymbol.name, fn]);
        }
        else if (n.kind === ts.SyntaxKind.ExportDeclaration) {
            let ed = <ts.ExportDeclaration>n;
            if (ed.moduleSpecifier) {
                let moduleSymbol = tc.getSymbolAtLocation(ed.moduleSpecifier);
                result.sourceDeps.push([moduleSymbol.name, moduleSymbol.valueDeclaration.getSourceFile().fileName]);
            }
        }
        else if (n.kind === ts.SyntaxKind.CallExpression) {
            let ce = <ts.CallExpression>n;
            if (isBobrilFunction('sprite', ce, result)) {
                let si: SpriteInfo = { callExpression: ce };
                for (let i = 0; i < ce.arguments.length; i++) {
                    let res = evalNode.evalNode(ce.arguments[i], tc, i === 0 ? resolvePathStringLiteral : null); // first argument is path
                    if (res !== undefined) switch (i) {
                        case 0:
                            if (typeof res === 'string') si.name = res;
                            break;
                        case 1:
                            if (typeof res === 'string') si.color = res;
                            break;
                        case 2:
                            if (typeof res === 'number') si.width = res;
                            break;
                        case 3:
                            if (typeof res === 'number') si.height = res;
                            break;
                        case 4:
                            if (typeof res === 'number') si.x = res;
                            break;
                        case 5:
                            if (typeof res === 'number') si.y = res;
                            break;
                        default: throw new Error('b.sprite cannot have more than 6 parameters');
                    }
                }
                result.sprites.push(si);
            } else if (isBobrilFunction('styleDef', ce, result) || isBobrilFunction('styleDefEx', ce, result)) {
                let item: StyleDefInfo = { callExpression: ce, isEx: isBobrilFunction('styleDefEx', ce, result), userNamed: false };
                if (ce.arguments.length == 3 + (item.isEx ? 1 : 0)) {
                    item.name = evalNode.evalNode(ce.arguments[ce.arguments.length - 1], tc, null);
                    item.userNamed = true;
                } else {
                    if (ce.parent.kind === ts.SyntaxKind.VariableDeclaration) {
                        let vd = <ts.VariableDeclaration>ce.parent;
                        item.name = (<ts.Identifier>vd.name).text;
                    } else if (ce.parent.kind === ts.SyntaxKind.BinaryExpression) {
                        let be = <ts.BinaryExpression>ce.parent;
                        if (be.operatorToken.kind === ts.SyntaxKind.FirstAssignment && be.left.kind === ts.SyntaxKind.Identifier) {
                            item.name = (<ts.Identifier>be.left).text;
                        }
                    }
                }
                result.styleDefs.push(item);
            } else if (isBobrilG11NFunction('t', ce, result)) {
                let item: TranslationMessage = { callExpression: ce, message: undefined, withParams: false, knownParams: undefined, hint: undefined };
                item.message = evalNode.evalNode(ce.arguments[0], tc, null);
                if (ce.arguments.length >= 2) {
                    item.withParams = true;
                    let params = evalNode.evalNode(ce.arguments[1], tc, null);
                    item.knownParams = params !== undefined && typeof params === "object" ? Object.keys(params) : [];
                }
                if (ce.arguments.length >= 3) {
                    item.hint = evalNode.evalNode(ce.arguments[2], tc, null);
                }
                result.trs.push(item);
            }
        }
        ts.forEachChild(n, visit);
    }
    visit(source);
    return result;
}

function createNodeFromValue(value: string | number | boolean): ts.Node {
    if (value === null) {
        let nullNode = ts.createNode(ts.SyntaxKind.NullKeyword);
        nullNode.pos = -1;
        return nullNode;
    }
    if (value === true) {
        let result = ts.createNode(ts.SyntaxKind.TrueKeyword);
        result.pos = -1;
        return result;
    }
    if (value === false) {
        let result = ts.createNode(ts.SyntaxKind.FalseKeyword);
        result.pos = -1;
        return result;
    }
    if (typeof value === "string") {
        let result = <ts.StringLiteral>ts.createNode(ts.SyntaxKind.StringLiteral);
        result.pos = -1;
        result.text = value;
        return result;
    }
    if (typeof value === "number") {
        let result = <ts.LiteralExpression>ts.createNode(ts.SyntaxKind.NumericLiteral);
        result.pos = -1;
        result.text = "" + value;
        return result;
    }
    throw new Error('Don\'t know how to create node for ' + value);
}

export function setMethod(callExpression: ts.CallExpression, name: string) {
    var ex = <ts.PropertyAccessExpression>callExpression.expression;
    let result = <ts.Identifier>ts.createNode(ts.SyntaxKind.Identifier);
    result.pos = -1;
    result.flags = ex.name.flags;
    result.text = name;
    ex.name = result;
    ex.pos = -1; // This is for correctly not wrap line after "b."
}

export function setArgument(callExpression: ts.CallExpression, index: number, value: string | number | boolean): void {
    while (callExpression.arguments.length < index) {
        callExpression.arguments.push(<ts.Expression>createNodeFromValue(null));
    }
    if (callExpression.arguments.length === index) {
        callExpression.arguments.push(<ts.Expression>createNodeFromValue(value));
    } else {
        callExpression.arguments[index] = <ts.Expression>createNodeFromValue(value);
    }
}

export function setArgumentCount(callExpression: ts.CallExpression, count: number) {
    var a = callExpression.arguments;
    while (a.length < count) {
        a.push(<ts.Expression>createNodeFromValue(null));
    }
    while (count < a.length) {
        a.pop();
    }
}

function assign(target: Object, ...sources: Object[]): Object {
    let totalArgs = arguments.length;
    for (let i = 1; i < totalArgs; i++) {
        let source = arguments[i];
        if (source == null) continue;
        let keys = Object.keys(source);
        let totalKeys = keys.length;
        for (let j = 0; j < totalKeys; j++) {
            let key = keys[j];
            (<any>target)[key] = (<any>source)[key];
        }
    }
    return target;
}

export function rememberCallExpression(callExpression: ts.CallExpression): () => void {
    let argumentsOriginal = callExpression.arguments;
    callExpression.arguments = <any>assign(argumentsOriginal.slice(0), argumentsOriginal);
    var ex = <ts.PropertyAccessExpression>callExpression.expression;
    let expressionName = ex.name;
    let expressionPos = ex.pos;
    return () => {
        callExpression.arguments = argumentsOriginal;
        ex.name = expressionName;
        ex.pos = expressionPos;
    };
}
