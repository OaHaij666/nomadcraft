import {describe,it,expect} from "vitest";
import {uploadPolicy, validUploadGiB} from "../nomad_policy";
describe("package upload policy",() => {
 it("defaults to five GiB with a corresponding expansion budget",()=>{expect(uploadPolicy()).toEqual({maxGiB:5,maxBytes:5368709120,maxExpandedBytes:21474836480});});
 it("validates admin limits without string coercion",()=>{for(const v of [0,-1,"5",NaN,Infinity,1025])expect(validUploadGiB(v)).toBe(false);for(const v of [0.01,5,100,1024])expect(validUploadGiB(v)).toBe(true);});
});
