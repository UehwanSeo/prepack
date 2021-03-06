/**
 * Copyright (c) 2017-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 */

/* @flow */

import type { BabelNodeCallExpression, BabelNodeExpression, BabelNodeStatement } from "@babel/types";
import type { Realm } from "../realm.js";
import { Effects } from "../realm.js";
import type { LexicalEnvironment } from "../environment.js";

import { AbruptCompletion, Completion, PossiblyNormalCompletion, SimpleNormalCompletion } from "../completions.js";
import { EnvironmentRecord, Reference } from "../environment.js";
import { EvaluateDirectCallWithArgList, GetThisValue, IsInTailPosition, SameValue } from "../methods/index.js";
import { Environment, Functions, Join } from "../singletons.js";
import { AbstractValue, BooleanValue, FunctionValue, Value } from "../values/index.js";

import * as t from "@babel/types";
import invariant from "../invariant.js";

// ECMA262 12.3.4.1
export default function(
  ast: BabelNodeCallExpression,
  strictCode: boolean,
  env: LexicalEnvironment,
  realm: Realm
): [Completion | Value, BabelNodeExpression, Array<BabelNodeStatement>] {
  // 1. Let ref be the result of evaluating MemberExpression.
  let [ref, calleeAst, calleeIO] = env.partiallyEvaluateCompletion(ast.callee, strictCode);
  if (ref instanceof AbruptCompletion) return [ref, (calleeAst: any), calleeIO];
  let completion;
  if (ref instanceof PossiblyNormalCompletion) {
    completion = ref;
    ref = completion.value;
  }
  invariant(ref instanceof Value || ref instanceof Reference);

  // 2. Let func be ? GetValue(ref).
  let func = Environment.GetValue(realm, ref);

  let io = calleeIO;
  let partialArgs = [];
  let argVals = [];
  for (let arg of ast.arguments) {
    let [argValue, argAst, argIO] = env.partiallyEvaluateCompletionDeref(arg, strictCode);
    io = io.concat(argIO);
    partialArgs.push((argAst: any));
    if (argValue instanceof AbruptCompletion) {
      if (completion instanceof PossiblyNormalCompletion)
        completion = Join.stopEffectCaptureJoinApplyAndReturnCompletion(completion, argValue, realm);
      else completion = argValue;
      let resultAst = t.callExpression((calleeAst: any), partialArgs);
      return [completion, resultAst, io];
    }
    if (argValue instanceof PossiblyNormalCompletion) {
      argVals.push(argValue.value);
      if (completion instanceof PossiblyNormalCompletion)
        completion = Join.composeNormalCompletions(completion, argValue, argValue.value, realm);
      else completion = argValue;
    } else {
      invariant(argValue instanceof Value);
      argVals.push(argValue);
    }
  }

  let previousLoc = realm.setNextExecutionContextLocation(ast.loc);
  try {
    let callResult = EvaluateCall(ref, func, ast, argVals, strictCode, env, realm);
    if (callResult instanceof AbruptCompletion) {
      if (completion instanceof PossiblyNormalCompletion)
        completion = Join.stopEffectCaptureJoinApplyAndReturnCompletion(completion, callResult, realm);
      else completion = callResult;
      let resultAst = t.callExpression((calleeAst: any), partialArgs);
      return [completion, resultAst, io];
    }
    let callCompletion;
    [callCompletion, callResult] = Join.unbundleNormalCompletion(callResult);
    invariant(callResult instanceof Value);
    invariant(completion === undefined || completion instanceof PossiblyNormalCompletion);
    completion = Join.composeNormalCompletions(completion, callCompletion, callResult, realm);
    if (completion instanceof PossiblyNormalCompletion) {
      realm.captureEffects(completion);
    }
    return [completion, t.callExpression((calleeAst: any), partialArgs), io];
  } finally {
    realm.setNextExecutionContextLocation(previousLoc);
  }
}

function callBothFunctionsAndJoinTheirEffects(
  funcs: Array<Value>,
  ast: BabelNodeCallExpression,
  argVals: Array<Value>,
  strictCode: boolean,
  env: LexicalEnvironment,
  realm: Realm
): AbruptCompletion | Value {
  let [cond, func1, func2] = funcs;
  invariant(cond instanceof AbstractValue && cond.getType() === BooleanValue);
  invariant(Value.isTypeCompatibleWith(func1.getType(), FunctionValue));
  invariant(Value.isTypeCompatibleWith(func2.getType(), FunctionValue));

  const e1 = realm.evaluateForEffects(
    () => EvaluateCall(func1, func1, ast, argVals, strictCode, env, realm),
    undefined,
    "callBothFunctionsAndJoinTheirEffects/1"
  );
  let r1 = e1.result.shallowCloneWithoutEffects();

  const e2 = realm.evaluateForEffects(
    () => EvaluateCall(func2, func2, ast, argVals, strictCode, env, realm),
    undefined,
    "callBothFunctionsAndJoinTheirEffects/2"
  );
  let r2 = e2.result.shallowCloneWithoutEffects();

  let joinedEffects = Join.joinForkOrChoose(
    realm,
    cond,
    new Effects(r1, e1.generator, e1.modifiedBindings, e1.modifiedProperties, e1.createdObjects),
    new Effects(r2, e2.generator, e2.modifiedBindings, e2.modifiedProperties, e2.createdObjects)
  );
  let joinedCompletion = joinedEffects.result;
  if (joinedCompletion instanceof PossiblyNormalCompletion) {
    // in this case one of the branches may complete abruptly, which means that
    // not all control flow branches join into one flow at this point.
    // Consequently we have to continue tracking changes until the point where
    // all the branches come together into one.
    joinedCompletion = realm.composeWithSavedCompletion(joinedCompletion);
  }

  // Note that the effects of (non joining) abrupt branches are not included
  // in joinedEffects, but are tracked separately inside joinedCompletion.
  realm.applyEffects(joinedEffects);

  // return or throw completion
  if (joinedCompletion instanceof SimpleNormalCompletion) joinedCompletion = joinedCompletion.value;
  invariant(joinedCompletion instanceof AbruptCompletion || joinedCompletion instanceof Value);
  return joinedCompletion;
}

function EvaluateCall(
  ref: Value | Reference,
  func: Value,
  ast: BabelNodeCallExpression,
  argList: Array<Value>,
  strictCode: boolean,
  env: LexicalEnvironment,
  realm: Realm
): AbruptCompletion | Value {
  if (func instanceof AbstractValue && Value.isTypeCompatibleWith(func.getType(), FunctionValue)) {
    if (func.kind === "conditional")
      return callBothFunctionsAndJoinTheirEffects(func.args, ast, argList, strictCode, env, realm);

    // The called function comes from the environmental model and we require that
    // such functions have no visible side-effects. Hence we can carry on
    // by returning a call node with the arguments updated with their partial counterparts.
    // TODO: obtain the type of the return value from the abstract function.
    return AbstractValue.createFromType(realm, Value);
  }
  // If func is abstract and not known to be a safe function, we can't safely continue.
  func = func.throwIfNotConcrete();

  // 3. If Type(ref) is Reference and IsPropertyReference(ref) is false and GetReferencedName(ref) is "eval", then
  if (
    ref instanceof Reference &&
    !Environment.IsPropertyReference(realm, ref) &&
    Environment.GetReferencedName(realm, ref) === "eval"
  ) {
    // a. If SameValue(func, %eval%) is true, then
    if (SameValue(realm, func, realm.intrinsics.eval)) {
      // i. Let argList be ? ArgumentListEvaluation(Arguments).

      // ii. If argList has no elements, return undefined.
      if (argList.length === 0) return realm.intrinsics.undefined;

      // iii. Let evalText be the first element of argList.
      let evalText = argList[0];

      // iv. If the source code matching this CallExpression is strict code, let strictCaller be true. Otherwise let strictCaller be false.
      let strictCaller = strictCode;

      // v. Let evalRealm be the current Realm Record.
      let evalRealm = realm;

      // vi. Return ? PerformEval(evalText, evalRealm, strictCaller, true).
      return Functions.PerformEval(realm, evalText, evalRealm, strictCaller, true);
    }
  }

  let thisValue;

  // 4. If Type(ref) is Reference, then
  if (ref instanceof Reference) {
    // a. If IsPropertyReference(ref) is true, then
    if (Environment.IsPropertyReference(realm, ref)) {
      // i. Let thisValue be GetThisValue(ref).
      thisValue = GetThisValue(realm, ref);
    } else {
      // b. Else, the base of ref is an Environment Record
      // i. Let refEnv be GetBase(ref).
      let refEnv = Environment.GetBase(realm, ref);
      invariant(refEnv instanceof EnvironmentRecord);

      // ii. Let thisValue be refEnv.WithBaseObject().
      thisValue = refEnv.WithBaseObject();
    }
  } else {
    // 5. Else Type(ref) is not Reference,
    // a. Let thisValue be undefined.
    thisValue = realm.intrinsics.undefined;
  }

  // 6. Let thisCall be this CallExpression.
  let thisCall = ast;

  // 7. Let tailCall be IsInTailPosition(thisCall). (See 14.6.1)
  let tailCall = IsInTailPosition(realm, thisCall);

  // 8. Return ? EvaluateDirectCall(func, thisValue, Arguments, tailCall).

  try {
    realm.currentLocation = ast.loc; // this helps us to detect recursive calls
    return EvaluateDirectCallWithArgList(realm, strictCode, env, ref, func, thisValue, argList, tailCall);
  } catch (err) {
    if (err instanceof Completion) return err;
    throw err;
  }
}
