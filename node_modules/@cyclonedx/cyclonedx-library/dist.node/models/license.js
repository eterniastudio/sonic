"use strict";
/*!
This file is part of CycloneDX JavaScript Library.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

   http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.

SPDX-License-Identifier: Apache-2.0
Copyright (c) OWASP Foundation. All Rights Reserved.
*/
Object.defineProperty(exports, "__esModule", { value: true });
exports.LicenseRepository = exports.SpdxLicense = exports.NamedLicense = exports.LicenseExpression = void 0;
const property_1 = require("./property");
class LicenseExpression {
    #expression;
    acknowledgement;
    constructor(expression) {
        this.expression = expression;
    }
    get expression() {
        return this.#expression;
    }
    set expression(value) {
        if (value === '') {
            throw new RangeError('value is empty string');
        }
        this.#expression = value;
    }
    compare(other) {
        return this.#expression.localeCompare(other.#expression);
    }
}
exports.LicenseExpression = LicenseExpression;
class DisjunctiveLicenseBase {
    acknowledgement;
    text;
    #url;
    properties;
    constructor(op = {}) {
        this.acknowledgement = op.acknowledgement;
        this.text = op.text;
        this.url = op.url;
        this.properties = op.properties ?? new property_1.PropertyRepository();
    }
    get url() {
        return this.#url;
    }
    set url(value) {
        this.#url = value === ''
            ? undefined
            : value;
    }
}
class NamedLicense extends DisjunctiveLicenseBase {
    name;
    constructor(name, op = {}) {
        super(op);
        this.name = name;
    }
    compare(other) {
        return this.name.localeCompare(other.name);
    }
}
exports.NamedLicense = NamedLicense;
class SpdxLicense extends DisjunctiveLicenseBase {
    #id;
    constructor(id, op = {}) {
        super(op);
        this.id = id;
    }
    get id() {
        return this.#id;
    }
    set id(value) {
        if (value === '') {
            throw new RangeError('value is empty string');
        }
        this.#id = value;
    }
    compare(other) {
        return this.#id.localeCompare(other.#id);
    }
}
exports.SpdxLicense = SpdxLicense;
class LicenseRepository extends Set {
    static #compareItems(a, b) {
        if (a.constructor === b.constructor) {
            return a.compare(b);
        }
        return a.constructor.name.localeCompare(b.constructor.name);
    }
    sorted() {
        return Array.from(this).sort(LicenseRepository.#compareItems);
    }
}
exports.LicenseRepository = LicenseRepository;
//# sourceMappingURL=license.js.map