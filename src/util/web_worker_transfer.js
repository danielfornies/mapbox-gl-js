// @flow

const assert = require('assert');

const Color = require('../style-spec/util/color');
const {
    StylePropertyFunction,
    StyleExpression,
    StyleExpressionWithErrorHandling,
    ZoomDependentExpression,
    ZoomConstantExpression
} = require('../style-spec/expression');
const {CompoundExpression} = require('../style-spec/expression/compound_expression');
const expressions = require('../style-spec/expression/definitions');

import type {Transferable} from '../types/transferable';

export type Serialized =
    | null
    | void
    | boolean
    | number
    | string
    | Boolean
    | Number
    | String
    | Date
    | RegExp
    | ArrayBuffer
    | $ArrayBufferView
    | Array<Serialized>
    | {| name: string, properties: {+[string]: Serialized} |};


type Registry = {
    [string]: {
        klass: Class<any>,
        omit: $ReadOnlyArray<string>,
        shallow: $ReadOnlyArray<string>
    }
};

type RegisterOptions<T> = {
    omit?: $ReadOnlyArray<$Keys<T>>,
    shallow?: $ReadOnlyArray<$Keys<T>>
}

const registry: Registry = {};

/**
 * Register the given class as serializable.
 *
 * @param options
 * @param options.omit List of properties to omit from serialization (e.g., cached/computed properties)
 * @param options.shallow List of properties that should be serialized by a simple shallow copy, rather than by a recursive call to serialize().
 *
 * @private
 */
function register<T: any>(klass: Class<T>, options: RegisterOptions<T> = {}) {
    const name: string = klass.name;
    assert(name);
    assert(!registry[name], `${name} is already registered.`);
    registry[name] = {
        klass,
        omit: options.omit || [],
        shallow: options.shallow || []
    };
}

register(Object);
register(Color);

register(StylePropertyFunction);
register(StyleExpression, {omit: ['_evaluator']});
register(StyleExpressionWithErrorHandling, {omit: ['_evaluator']});
register(ZoomDependentExpression);
register(ZoomConstantExpression);
register(CompoundExpression, {omit: ['_evaluate']});
for (const name in expressions) {
    const Expression = expressions[name];
    if (registry[Expression.name]) continue;
    register(expressions[name]);
}

/**
 * Serialize the given object for transfer to or from a web worker.
 *
 * For non-builtin types, recursively serialize each property (possibly
 * omitting certain properties - see register()), and package the result along
 * with the constructor's `name` so that the appropriate constructor can be
 * looked up in `deserialize()`.
 *
 * If a `transferables` array is provided, add any transferable objects (i.e.,
 * any ArrayBuffers or ArrayBuffer views) to the list. (If a copy is needed,
 * this should happen in the client code, before using serialize().)
 */
function serialize(input: mixed, transferables?: Array<Transferable>): Serialized {
    if (input === null ||
        input === undefined ||
        typeof input === 'boolean' ||
        typeof input === 'number' ||
        typeof input === 'string' ||
        input instanceof Boolean ||
        input instanceof Number ||
        input instanceof String ||
        input instanceof Date ||
        input instanceof RegExp) {
        return input;
    }

    if (input instanceof ArrayBuffer) {
        if (transferables) {
            transferables.push(input);
        }
        return input;
    }

    if (ArrayBuffer.isView(input)) {
        const view: $ArrayBufferView = (input: any);
        if (transferables) {
            transferables.push(view.buffer);
        }
        return view;
    }

    if (Array.isArray(input)) {
        const serialized = [];
        for (const item of input) {
            serialized.push(serialize(item, transferables));
        }
        return serialized;
    }

    if (typeof input === 'object') {
        const klass = (input.constructor: any);
        const name = klass.name;
        if (!name) {
            throw new Error(`can't serialize object of anonymous class`);
        }

        if (!registry[name]) {
            throw new Error(`can't serialize unregistered class ${name}`);
        }

        const properties: {[string]: Serialized} = {};

        if (klass.serialize) {
            // (Temporary workaround) allow a class to provide static
            // `serialize()` and `deserialize()` methods to bypass the generic
            // approach.
            // This temporary workaround lets us use the generic serialization
            // approach for objects whose members include instances of dynamic
            // StructArray types. Once we refactor StructArray to be static,
            // we can remove this complexity.
            properties._serialized = (klass.serialize: typeof serialize)(input, transferables);
        } else {
            for (const key in input) {
                // any cast due to https://github.com/facebook/flow/issues/5393
                if (!(input: any).hasOwnProperty(key)) continue;
                if (registry[name].omit.indexOf(key) >= 0) continue;
                const property = (input: any)[key];
                properties[key] = registry[name].shallow.indexOf(key) >= 0 ?
                    property :
                    serialize(property, transferables);
            }
        }

        return {name, properties};
    }

    throw new Error(`can't serialize object of type ${typeof input}`);
}

function deserialize(input: Serialized): mixed {
    if (input === null ||
        input === undefined ||
        typeof input === 'boolean' ||
        typeof input === 'number' ||
        typeof input === 'string' ||
        input instanceof Boolean ||
        input instanceof Number ||
        input instanceof String ||
        input instanceof Date ||
        input instanceof RegExp ||
        input instanceof ArrayBuffer ||
        ArrayBuffer.isView(input)) {
        return input;
    }

    if (Array.isArray(input)) {
        return input.map((i) => deserialize(i));
    }

    if (typeof input === 'object') {
        const {name, properties} = (input: any);
        if (!name) {
            throw new Error(`can't deserialize object of anonymous class`);
        }

        const {klass} = registry[name];
        if (!klass) {
            throw new Error(`can't deserialize unregistered class ${name}`);
        }

        if (klass.deserialize) {
            return (klass.deserialize: typeof deserialize)(properties._serialized);
        }

        const result = Object.create(klass.prototype);

        for (const key of Object.keys(properties)) {
            result[key] = registry[name].shallow.indexOf(key) >= 0 ?
                properties[key] : deserialize(properties[key]);
        }

        return result;
    }

    throw new Error(`can't deserialize object of type ${typeof input}`);
}

module.exports = {
    register,
    serialize,
    deserialize
};
