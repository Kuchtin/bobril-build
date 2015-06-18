import * as ts from "typescript";
import * as fs from "fs";
import * as path from "path";
import * as evalNode from "./evalNode";
import * as spriter from "./spriter";
import * as imageOps from "./imageOps";

export interface SourceInfo {
    sprites: SpriteInfo[];
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

export function gatherSourceInfo(source: ts.SourceFile, tc: ts.TypeChecker): SourceInfo {
    let result: SourceInfo = { sprites: [] };
    function visit(n: ts.Node) {
        if (n.kind === ts.SyntaxKind.CallExpression) {
            let ce = <ts.CallExpression>n;
            if (ce.expression.getText() === "b.sprite") {
                let si: SpriteInfo = { callExpression: ce };
                for (let i = 0; i < ce.arguments.length; i++) {
                    let res = evalNode.evalNode(ce.arguments[i], tc, i === 0); // first argument is path
                    if (res !== undefined) switch (i) {
                        case 0:
                            if (typeof res === "string") si.name = res;
                            break;
                        case 1:
                            if (typeof res === "string") si.color = res;
                            break;
                        case 2:
                            if (typeof res === "number") si.width = res;
                            break;
                        case 3:
                            if (typeof res === "number") si.height = res;
                            break;
                        case 4:
                            if (typeof res === "number") si.x = res;
                            break;
                        case 5:
                            if (typeof res === "number") si.y = res;
                            break;
                        default: throw new Error("b.sprite cannot have more than 6 parameters");
                    }
                }
                result.sprites.push(si);
            }
        }
        ts.forEachChild(n, visit);
    }
    visit(source);
    return result;
}

function createNodeFromValue(value: string|number|boolean): ts.Node {
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
    throw new Error("Don't know how to create node for " + value);
}

export function setArgument(callExpression: ts.CallExpression, index: number, value: string|number|boolean): void {
    while (callExpression.arguments.length < index) {
        callExpression.arguments.push(<ts.Expression>createNodeFromValue(null));
    }
    if (callExpression.arguments.length === index) {
        callExpression.arguments.push(<ts.Expression>createNodeFromValue(value));
    } else {
        callExpression.arguments[index] = <ts.Expression>createNodeFromValue(value);
    }
}

var defaultLibFilename = path.join(path.dirname(path.resolve(require.resolve("typescript"))), "lib.es6.d.ts");
var defaultLibFilenameNorm = defaultLibFilename.replace(/\\/g, "/");

var lastLibPrecompiled;

function createCompilerHost(currentDirectory) {
    function getCanonicalFileName(fileName) {
        return ts.sys.useCaseSensitiveFileNames ? fileName : fileName.toLowerCase();
    }
    function getSourceFile(filename, languageVersion, onError) {
        if (filename === defaultLibFilenameNorm && lastLibPrecompiled) {
            return lastLibPrecompiled;
        }
        var text = fs.readFileSync(filename === defaultLibFilenameNorm ? defaultLibFilename : path.resolve(currentDirectory, filename)).toString();
        if (filename === defaultLibFilenameNorm) {
            lastLibPrecompiled = ts.createSourceFile(filename, text, languageVersion, true);
            return lastLibPrecompiled;
        }
        return ts.createSourceFile(filename, text, languageVersion, true);
    }
    function writeFile(fileName, data, writeByteOrderMark, onError) {
        fileName = path.join(currentDirectory, fileName);
        console.log("Writing "+fileName);
        try {
            var text = ts.sys.readFile(fileName, 'utf-8');
        } catch (e) {
            text = "";
        }
        if (text === data) {
            fs.utimesSync(fileName, new Date(), new Date());
            return;
        }
        try {
            ts.sys.writeFile(fileName, data, false);
        } catch (e) {
            if (onError) {
                onError(e.message);
            }
        }
    }
    return {
        getSourceFile: getSourceFile,
        getDefaultLibFileName: function(options) { return defaultLibFilename; },
        writeFile: writeFile,
        getCurrentDirectory: function() { return currentDirectory; },
        useCaseSensitiveFileNames: function() { return ts.sys.useCaseSensitiveFileNames; },
        getCanonicalFileName: getCanonicalFileName,
        getNewLine: function() { return '\n'; }
    };
}

function reportDiagnostic(diagnostic) {
    var output = "";
    if (diagnostic.file) {
        var loc = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
        output += diagnostic.file.fileName + "(" + loc.line + "," + loc.character + "): ";
    }
    var category = ts.DiagnosticCategory[diagnostic.category].toLowerCase();
    output += category + " TS" + diagnostic.code + ": " + diagnostic.messageText + ts.sys.newLine;
    ts.sys.write(output);
}

function reportDiagnostics(diagnostics) {
    for (var i = 0; i < diagnostics.length; i++) {
        reportDiagnostic(diagnostics[i]);
    }
}

export function compile(done: ()=>void) {
    var full = "c:/Research/bobrilapp";
    var program = ts.createProgram(["app.ts"], { module: ts.ModuleKind.CommonJS }, createCompilerHost(full));
    var diagnostics = program.getSyntacticDiagnostics();
    reportDiagnostics(diagnostics);
    if (diagnostics.length === 0) {
        var diagnostics = program.getGlobalDiagnostics();
        reportDiagnostics(diagnostics);
        if (diagnostics.length === 0) {
            var diagnostics = program.getSemanticDiagnostics();
            reportDiagnostics(diagnostics);
        }
    }
    var tc = program.getTypeChecker();
    var sourceFiles = program.getSourceFiles();
    var prom = Promise.resolve<any>(null);
    var spriteMap = Object.create(null);

    for (let i = 0; i < sourceFiles.length; i++) {
        var src = sourceFiles[i];
        if (src.hasNoDefaultLib) continue; // skip searching default lib
        var srcInfo = gatherSourceInfo(src, tc);
        //console.log(src.fileName);
        //console.log(srcInfo);
        if (srcInfo.sprites.length > 0) {
            for (let i = 0; i < srcInfo.sprites.length; i++) {
                var si = srcInfo.sprites[i];
                (function(name) {
                    prom = prom.then(() => {
                        return imageOps.loadPNG(path.join(full, name)).then(img=> {
                            spriteMap[name] = img;
                        })
                    })
                })(si.name);
            }
        }
    }

    prom = prom.then(() => {
        let spList = <spriter.SpritePlace[]>[];
        for (let i = 0; i < sourceFiles.length; i++) {
            var src = sourceFiles[i];
            if (src.hasNoDefaultLib) continue; // skip searching default lib
            var srcInfo = gatherSourceInfo(src, tc);
            if (srcInfo.sprites.length > 0) {
                for (let i = 0; i < srcInfo.sprites.length; i++) {
                    var si = srcInfo.sprites[i];
                    spList.push({
                        width: (<imageOps.Image>spriteMap[si.name]).width,
                        height: (<imageOps.Image>spriteMap[si.name]).height, x: 0, y: 0, img: spriteMap[si.name], name: si.name
                    });
                }
            }
        }
        let dim = spriter.spritePlace(spList);
        let bundleImage = imageOps.createImage(dim[0], dim[1]);
        for (let i = 0; i < spList.length; i++) {
            let sp = spList[i];
            imageOps.drawImage(<imageOps.Image>(<any>sp).img, bundleImage, sp.x, sp.y);
        }
        imageOps.savePNG(bundleImage, path.join(full, "bundle.png"))
        for (let i = 0; i < sourceFiles.length; i++) {
            var src = sourceFiles[i];
            if (src.hasNoDefaultLib) continue; // skip searching default lib
            var srcInfo = gatherSourceInfo(src, tc);
            if (srcInfo.sprites.length > 0) {
                for (let i = 0; i < srcInfo.sprites.length; i++) {
                    var si = srcInfo.sprites[i];
                    for (let j = 0; j < spList.length; j++) {
                        if ((<any>spList[j]).name === si.name) {
                            setArgument(si.callExpression, 0, "bundle.png");
                            setArgument(si.callExpression, 1, null);
                            setArgument(si.callExpression, 2, spList[j].width);
                            setArgument(si.callExpression, 3, spList[j].height);
                            setArgument(si.callExpression, 4, spList[j].x);
                            setArgument(si.callExpression, 5, spList[j].y);
                        }
                    }
                }
            }
            program.emit(src);
        }
    }).then(done);
}