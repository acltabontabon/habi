/** Where Habi's people and places live; every one opens in the system browser. */
import pkg from "../../package.json";

/** The repository Habi is developed in (from package.json). */
export const REPOSITORY = pkg.repository.url.replace(/\.git$/, "");
export const ISSUES = `${REPOSITORY}/issues`;
export const RELEASES_PAGE = `${REPOSITORY}/releases`;

/** The developer, and the one place to support the work (also .github/FUNDING.yml). */
export const AUTHOR = { name: "Alvin Cris Tabontabon", site: "https://acltabontabon.com" };
export const SUPPORT = "https://ko-fi.com/aclt_attic";

/** The security policy, and the model of what Habi will and will not do. */
export const SECURITY = `${REPOSITORY}/blob/main/SECURITY.md`;
export const SECURITY_MODEL = `${REPOSITORY}/blob/main/docs/project/security-model.md`;
