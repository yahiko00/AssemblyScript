/** @module assemblyscript/reflection */ /** */

import * as binaryen from "binaryen";
import { isRuntime } from "../builtins";
import { Class, TypeArgumentsMap } from "./class";
import { Compiler, CompilerMemoryModel } from "../compiler";
import { Type, voidType } from "./type";
import { Variable, VariableFlags } from "./variable";
import * as typescript from "../typescript";
import * as util from "../util";

/** Common base class of {@link Function} and {@link FunctionTemplate}. */
export abstract class FunctionBase {

  /** Global name. */
  name: string;
  /** Declaration reference. */
  declaration: typescript.FunctionLikeDeclaration;

  protected constructor(name: string, declaration: typescript.FunctionLikeDeclaration) {
    this.name = name;
    this.declaration = declaration;
  }

  /** Simple name. */
  get simpleName(): string { return typescript.getTextOfNode(<typescript.Identifier>this.declaration.name); }
  /** Tests if this function is imported (just a declaration). */
  get isImport(): boolean { return util.isDeclare(this.declaration); }
  /** Tests if this function is exported to the embedder. */
  get isExport(): boolean { return util.isExport(this.declaration, true); }
  /** Tests if this function is an instance member / not static. */
  get isInstance(): boolean { return this.isConstructor || !util.isStatic(this.declaration) && this.declaration.kind === typescript.SyntaxKind.MethodDeclaration; }
  /** Tests if this function is the constructor of a class. */
  get isConstructor(): boolean { return this.declaration.kind === typescript.SyntaxKind.Constructor; }
  /** Tests if this function is a getter. */
  get isGetter(): boolean { return this.declaration.kind === typescript.SyntaxKind.GetAccessor; }
  /** Tests if this function is a setter. */
  get isSetter(): boolean { return this.declaration.kind === typescript.SyntaxKind.SetAccessor; }

  toString(): string { return this.name; }
}

/** Interface describing a reflected function parameter. */
export interface FunctionParameter {
  /** Simple name. */
  name: string;
  /** Resolved type. */
  type: Type;
  /** Parameter node reference. */
  node: typescript.Node;
  /** Whether this parameter also introduces a property (like when used with the `public` keyword). */
  isAlsoProperty?: boolean;
  /** Optional value initializer. */
  initializer?: typescript.Expression;
}

/** A function instance with generic parameters resolved. */
export class Function extends FunctionBase {

  /** Corresponding function template. */
  template: FunctionTemplate;
  /** Resolved type arguments. */
  typeArguments: TypeArgumentsMap;
  /** Function parameters including `this`. */
  parameters: FunctionParameter[];
  /** Resolved return type. */
  returnType: Type;
  /** Parent class, if any. */
  parent?: Class;
  /** Body reference, if not just a declaration. */
  body?: typescript.Block | typescript.Expression;

  // Set on initialization

  /** Local variables. */
  locals: Variable[];
  /** Local variables by name for lookups. */
  localsByName: { [key: string]: Variable };
  /** Resolved binaryen parameter types. */
  binaryenParameterTypes: binaryen.Type[];
  /** Resolved binaryen return type. */
  binaryenReturnType: binaryen.Type;
  /** Binaryen signature id, for example "iiv". */
  binaryenSignatureId: string;
  /** Binaryen signature reference. */
  binaryenSignature: binaryen.Signature;

  // Set on compilation

  /** Whether this function has already been compiled. */
  compiled: boolean = false;
  /** Whether this function has been imported. */
  imported: boolean = false;
  /** Number of the current break context. */
  breakNumber: number = 0;
  /** Depth within the current break context. */
  breakDepth: number = 0;
  /** Binaryen function reference. */
  binaryenFunction: binaryen.Function;

  /** Constructs a new reflected function instance and binds it to its TypeScript declaration. */
  constructor(name: string, template: FunctionTemplate, typeArguments: TypeArgumentsMap, parameters: FunctionParameter[], returnType: Type, parent?: Class, body?: typescript.Block | typescript.Expression) {
    super(name, template.declaration);

    this.template = template;
    this.typeArguments = typeArguments;
    this.parameters = parameters;
    this.returnType = returnType;
    this.parent = parent;
    this.body = body;

    util.setReflectedFunction(template.declaration, this);
  }

  /** Gets the current break label for use with binaryen loops and blocks. */
  get breakLabel(): string { return this.breakNumber + "." + this.breakDepth; }

  /** Initializes this function. Does not compile it, yet. */
  initialize(compiler: Compiler): void {
    this.binaryenParameterTypes = [];
    this.locals = [];
    this.localsByName = {};
    const ids: string[] = [];

    for (let i = 0, k = this.parameters.length; i < k; ++i) {
      const variable = new Variable(this.parameters[i].name, this.parameters[i].type, VariableFlags.none, this.locals.length);
      this.binaryenParameterTypes.push(compiler.typeOf(this.parameters[i].type));
      this.locals.push(variable);
      this.localsByName[variable.name] = variable;
      ids.push(compiler.identifierOf(this.parameters[i].type));
    }

    this.binaryenReturnType = compiler.typeOf(this.returnType);
    ids.push(compiler.identifierOf(this.returnType));

    this.binaryenSignatureId = ids.join("");
    this.binaryenSignature = compiler.module.getFunctionTypeBySignature(this.binaryenReturnType, this.binaryenParameterTypes);
    if (!this.binaryenSignature)
      this.binaryenSignature = compiler.module.addFunctionType(this.binaryenSignatureId, this.binaryenReturnType, this.binaryenParameterTypes);
  }

  /** Introduces an additional local variable. */
  addLocal(name: string, type: Type): Variable {
    const variable = new Variable(name, type, VariableFlags.none, this.locals.length);
    this.locals.push(variable);
    this.localsByName[variable.name] = variable;
    return variable;
  }

  /** Compiles a call to this function using the specified arguments. Arguments to instance functions include `this` as the first argument or can specifiy it in `thisArg`. */
  makeCall(compiler: Compiler, argumentNodes: typescript.Expression[], thisArg?: binaryen.Expression): binaryen.Expression {
    const op = compiler.module;
    const operands: binaryen.Expression[] = new Array(this.parameters.length);
    let operandIndex = 0;

    if (thisArg !== undefined)
      operands[operandIndex++] = thisArg;

    if (operandIndex + argumentNodes.length > this.parameters.length)
      throw Error("too many arguments: " + argumentNodes.length + " > " + this.parameters.length); // handled by typescript

    // specified arguments
    for (let i = 0; i < argumentNodes.length && operandIndex < this.parameters.length; ++i, ++operandIndex)
      operands[operandIndex] = compiler.compileExpression(argumentNodes[i], this.parameters[operandIndex].type, this.parameters[operandIndex].type, false);

    // omitted arguments
    while (operandIndex < this.parameters.length) {
      const initializer = this.parameters[operandIndex].initializer;
      let expr: binaryen.Expression;
      if (initializer) {
        // FIXME: initializers are currently compiled in the context of the calling function,
        // preventing proper usage of 'this'
        expr = compiler.compileExpression(initializer, this.parameters[operandIndex].type, this.parameters[operandIndex].type, false);
      } else
        throw Error("too few arguments: " + operandIndex + " < " + this.parameters.length); // handled by typescript
      operands[operandIndex++] = expr;
    }

    if (operandIndex !== operands.length)
      throw Error("unexpected operand index");

    let internalName = this.name;
    let isImport = this.isImport;

    // Rewire runtime calls
    if (isRuntime(this.name, true)) {
      internalName = this.simpleName;
      if (compiler.memoryModel === CompilerMemoryModel.MALLOC || compiler.memoryModel === CompilerMemoryModel.EXPORT_MALLOC)
        isImport = false;

    // Compile if not yet compiled
    } else if (!this.compiled) {
      if (this.body || this.isImport)
        compiler.compileFunction(this);
      else
        throw Error("cannot compile a non-import function without a body");
    }

    return (isImport ? op.callImport : op.call)(internalName, operands, compiler.typeOf(this.returnType));
  }
}

export { Function as default };

/** A function template with possibly unresolved generic parameters. */
export class FunctionTemplate extends FunctionBase {

  /** Declaration reference. */
  declaration: typescript.FunctionLikeDeclaration;
  /** So far resolved instances by global name. */
  instances: { [key: string]: Function };

  /** Constructs a new reflected function template and binds it to its TypeScript declaration. */
  constructor(name: string, declaration: typescript.FunctionLikeDeclaration) {
    super(name, declaration);

    this.declaration = declaration;
    this.instances = {};

    util.setReflectedFunctionTemplate(declaration, this);
  }

  /** Tests if this function requires type arguments. */
  get isGeneric(): boolean { return !!(this.declaration.typeParameters && this.declaration.typeParameters.length); }

  /** Resolves this possibly generic function against the provided type arguments. */
  resolve(compiler: Compiler, typeArgumentNodes: typescript.TypeNode[], typeArgumentsMap?: TypeArgumentsMap): Function {
    const parent = this.declaration.parent ? util.getReflectedClass(<typescript.ClassDeclaration>this.declaration.parent) : undefined;

    const typeParametersCount = this.declaration.typeParameters && this.declaration.typeParameters.length || 0;
    if (typeArgumentNodes.length !== typeParametersCount)
      throw Error("type parameter count mismatch");

    let name = this.name;

    // Inherit contextual type arguments, if applicablee
    if (!typeArgumentsMap)
      typeArgumentsMap = {};

    // Inherit class type arguments, if an instance method
    if (parent && this.isInstance)
      Object.keys(parent.typeArguments).forEach(key => (<TypeArgumentsMap>typeArgumentsMap)[key] = parent.typeArguments[key]);

    // Handle function type arguments
    if (typeParametersCount) {
      const typeNames: string[] = new Array(typeParametersCount);
      for (let i = 0; i < typeParametersCount; ++i) {
        const parameterDeclaration = (<typescript.NodeArray<typescript.TypeParameterDeclaration>>this.declaration.typeParameters)[i];
        const type = compiler.resolveType(typeArgumentNodes[i], false, typeArgumentsMap) || voidType; // reports
        const typeName = typescript.getTextOfNode(<typescript.Identifier>parameterDeclaration.name);
        typeArgumentsMap[typeName] = {
          type: type,
          node: <typescript.TypeNode><any>parameterDeclaration
        };
        typeNames[i] = type.toString();
      }
      name += "<" + typeNames.join(",") + ">";
    }

    if (this.instances[name])
      return this.instances[name];

    // Resolve function parameters
    const parameters: FunctionParameter[] = new Array(this.declaration.parameters.length);
    for (let i = 0, k = this.declaration.parameters.length; i < k; ++i) {
      const parameter = this.declaration.parameters[i];

      if (!parameter.type)
        compiler.report(parameter.name, typescript.DiagnosticsEx.Type_expected);

      if (parameter.questionToken && !util.isDeclare(this.declaration, true) && !parameter.initializer)
        compiler.report(parameter.questionToken, typescript.DiagnosticsEx.Optional_parameters_must_specify_an_initializer);

      parameters[i] = {
        node: parameter,
        name: typescript.getTextOfNode(parameter.name),
        type: parameter.type
          ? compiler.resolveType(parameter.type, false, typeArgumentsMap) || voidType // reports
          : voidType,
        initializer: parameter.initializer
      };
      if (!parameter.type && typescript.getSourceFileOfNode(this.declaration) !== compiler.libraryFile) // library may use 'any'
        compiler.report(parameter.name, typescript.DiagnosticsEx.Type_expected);
    }
    if (this.isInstance) {
      parameters.unshift({
        node: this.declaration,
        name: "this",
        type: compiler.uintptrType
      });
    }

    let returnType: Type;
    if (parent && this.isConstructor)
      returnType = parent.type;
    else if (this.declaration.type) {
      const returnTypeNode = this.declaration.type;
      if (returnTypeNode.kind === typescript.SyntaxKind.ThisType && parent)
        returnType = parent.type;
      else
        returnType = compiler.resolveType(returnTypeNode, true, typeArgumentsMap) || voidType; // reports
    } else {
      returnType = voidType;
      if (typescript.getSourceFileOfNode(this.declaration) !== compiler.libraryFile && this.declaration.kind !== typescript.SyntaxKind.SetAccessor) // library may use 'any'
        compiler.report(<typescript.Identifier>this.declaration.name, typescript.DiagnosticsEx.Assuming_return_type_0, "void");
    }

    return this.instances[name] = new Function(name, this, typeArgumentsMap, parameters, returnType, parent, this.declaration.body);
  }
}
