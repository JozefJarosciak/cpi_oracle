/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/cpi_oracle.json`.
 */
export type CpiOracle = {
  "address": string;
  "metadata": {
    "name": string;
    "version": string;
    "spec": string;
  };
  "instructions": Array<any>;
};

export const IDL: CpiOracle;
