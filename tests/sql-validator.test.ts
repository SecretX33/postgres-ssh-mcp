import { describe, it, expect } from "vitest";
import { validateQuery, ValidationError } from "../src/sql-validator.js";

describe("ValidationError", () => {
  it("is an instance of Error with a code property", () => {
    const err = new ValidationError("PARSE_ERROR", "bad sql");
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe("PARSE_ERROR");
    expect(err.message).toBe("bad sql");
  });
});

describe("validateQuery – always-on checks (readOnly=false)", () => {
  it("throws EMPTY_QUERY for empty input", async () => {
    await expect(validateQuery("", false)).rejects.toMatchObject({
      code: "EMPTY_QUERY",
    });
  });

  it("throws MULTI_STATEMENT for multiple statements", async () => {
    await expect(
      validateQuery("SELECT 1; DROP TABLE t", false),
    ).rejects.toMatchObject({ code: "MULTI_STATEMENT" });
  });
});

describe("validateQuery – allowlist (readOnly=true)", () => {
  it("accepts a plain SELECT", async () => {
    await expect(validateQuery("SELECT 1", true)).resolves.toBeUndefined();
  });

  it("accepts EXPLAIN SELECT", async () => {
    await expect(
      validateQuery("EXPLAIN SELECT * FROM users", true),
    ).resolves.toBeUndefined();
  });

  it("rejects INSERT", async () => {
    await expect(
      validateQuery("INSERT INTO t(x) VALUES (1)", true),
    ).rejects.toMatchObject({
      code: "FORBIDDEN_STATEMENT",
    });
  });

  it("rejects UPDATE", async () => {
    await expect(validateQuery("UPDATE t SET x = 1", true)).rejects.toMatchObject({
      code: "FORBIDDEN_STATEMENT",
    });
  });

  it("rejects DELETE", async () => {
    await expect(validateQuery("DELETE FROM t", true)).rejects.toMatchObject({
      code: "FORBIDDEN_STATEMENT",
    });
  });

  it("rejects CREATE TABLE", async () => {
    await expect(validateQuery("CREATE TABLE t (id INT)", true)).rejects.toMatchObject({
      code: "FORBIDDEN_STATEMENT",
    });
  });

  it("rejects DROP TABLE", async () => {
    await expect(validateQuery("DROP TABLE t", true)).rejects.toMatchObject({
      code: "FORBIDDEN_STATEMENT",
    });
  });

  it("rejects TRUNCATE", async () => {
    await expect(validateQuery("TRUNCATE t", true)).rejects.toMatchObject({
      code: "FORBIDDEN_STATEMENT",
    });
  });
});

describe("validateQuery – EXPLAIN inner check (readOnly=true)", () => {
  it("rejects EXPLAIN DELETE", async () => {
    await expect(validateQuery("EXPLAIN DELETE FROM t", true)).rejects.toMatchObject({
      code: "FORBIDDEN_EXPLAIN_TARGET",
    });
  });

  it("rejects EXPLAIN INSERT", async () => {
    await expect(
      validateQuery("EXPLAIN INSERT INTO t(x) VALUES (1)", true),
    ).rejects.toMatchObject({ code: "FORBIDDEN_EXPLAIN_TARGET" });
  });

  it("rejects EXPLAIN UPDATE", async () => {
    await expect(
      validateQuery("EXPLAIN UPDATE t SET x = 1", true),
    ).rejects.toMatchObject({
      code: "FORBIDDEN_EXPLAIN_TARGET",
    });
  });
});

describe("validateQuery – deep AST walk (readOnly=true)", () => {
  it("rejects mutating CTE (WITH … DELETE … SELECT)", async () => {
    await expect(
      validateQuery(
        `WITH deleted AS (DELETE FROM t RETURNING id)SELECT *FROM deleted`,
        true,
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN_NESTED_MUTATION" });
  });

  it("rejects mutating CTE (WITH … INSERT … SELECT)", async () => {
    await expect(
      validateQuery(
        `WITH ins AS (INSERT INTO t(x) VALUES (1) RETURNING id) SELECT * FROM ins`,
        true,
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN_NESTED_MUTATION" });
  });

  it("rejects SELECT INTO", async () => {
    await expect(
      validateQuery("SELECT * INTO new_table FROM old_table", true),
    ).rejects.toMatchObject({ code: "FORBIDDEN_SELECT_INTO" });
  });

  it("rejects SELECT FOR UPDATE", async () => {
    await expect(validateQuery("SELECT * FROM t FOR UPDATE", true)).rejects.toMatchObject(
      {
        code: "FORBIDDEN_LOCKING",
      },
    );
  });

  it("rejects SELECT FOR SHARE", async () => {
    await expect(validateQuery("SELECT * FROM t FOR SHARE", true)).rejects.toMatchObject({
      code: "FORBIDDEN_LOCKING",
    });
  });

  it("accepts a nested subquery SELECT (no mutation)", async () => {
    await expect(
      validateQuery("SELECT * FROM (SELECT id FROM t WHERE x > 1) sub", true),
    ).resolves.toBeUndefined();
  });

  it("accepts a read-only CTE", async () => {
    await expect(
      validateQuery(`WITH cte AS (SELECT id FROM t)SELECT *FROM cte`, true),
    ).resolves.toBeUndefined();
  });
});

describe("validateQuery – allowlist skipped (readOnly=false)", () => {
  it("allows DELETE when readOnly=false", async () => {
    await expect(validateQuery("DELETE FROM t", false)).resolves.toBeUndefined();
  });

  it("allows INSERT when readOnly=false", async () => {
    await expect(
      validateQuery("INSERT INTO t(x) VALUES (1)", false),
    ).resolves.toBeUndefined();
  });
});
