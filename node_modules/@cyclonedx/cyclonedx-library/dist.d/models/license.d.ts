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
import type { Sortable } from '../_helpers/sortable';
import type { LicenseAcknowledgement } from '../enums/licenseAcknowledgement';
import type { SpdxId } from '../spdx';
import type { Attachment } from './attachment';
import { PropertyRepository } from './property';
/**
 * (SPDX) License Expression.
 *
 * No validation is done internally.
 * You may validate with {@link SPDX.isValidSpdxLicenseExpression | SPDX.isValidSpdxLicenseExpression()}.
 * You may assert valid objects with {@link Factories.LicenseFactory.makeExpression | Factories.LicenseFactory.makeExpression()}.
 */
export declare class LicenseExpression {
    #private;
    acknowledgement?: LicenseAcknowledgement;
    /**
     * @throws {@link RangeError} if `expression` is empty string
     */
    constructor(expression: LicenseExpression['expression']);
    get expression(): string;
    /**
     * @throws {@link RangeError} if `value` is empty string
     */
    set expression(value: string);
    compare(other: LicenseExpression): number;
}
declare class DisjunctiveLicenseBase {
    #private;
    acknowledgement?: LicenseAcknowledgement;
    text?: Attachment;
    properties: PropertyRepository;
    constructor(op?: OptionalDisjunctiveLicenseProperties);
    get url(): URL | string | undefined;
    set url(value: URL | string | undefined);
}
interface OptionalDisjunctiveLicenseProperties {
    acknowledgement?: DisjunctiveLicenseBase['acknowledgement'];
    text?: DisjunctiveLicenseBase['text'];
    url?: DisjunctiveLicenseBase['url'];
    properties?: DisjunctiveLicenseBase['properties'];
}
export interface OptionalNamedLicenseProperties extends OptionalDisjunctiveLicenseProperties {
}
export declare class NamedLicense extends DisjunctiveLicenseBase {
    name: string;
    constructor(name: string, op?: OptionalNamedLicenseProperties);
    compare(other: NamedLicense): number;
}
export interface OptionalSpdxLicenseProperties extends OptionalDisjunctiveLicenseProperties {
}
/**
 * Disjunctive license with (SPDX-)ID - aka SpdxLicense.
 *
 * No validation is done internally.
 * You may validate with {@link SPDX.isSupportedSpdxId | SPDX.isSupportedSpdxId()}.
 * You may assert valid objects with {@link Factories.LicenseFactory.makeSpdxLicense | Factories.LicenseFactory.makeSpdxLicense()}.
 */
export declare class SpdxLicense extends DisjunctiveLicenseBase {
    #private;
    /**
     * @throws {@link RangeError} if `id` is empy string
     */
    constructor(id: SpdxId, op?: OptionalSpdxLicenseProperties);
    get id(): SpdxId;
    /**
     * @throws {@link RangeError} if `value` is empy string
     */
    set id(value: SpdxId);
    compare(other: SpdxLicense): number;
}
export type DisjunctiveLicense = NamedLicense | SpdxLicense;
export type License = DisjunctiveLicense | LicenseExpression;
export declare class LicenseRepository extends Set<License> implements Sortable<License> {
    #private;
    sorted(): License[];
}
export {};
//# sourceMappingURL=license.d.ts.map