// The React side of i18n (T114, FR-78): one context carrying the translate
// function. The default is identity — a component outside the provider (or
// before the dictionary loads) simply shows the English source strings.

import { createContext, useContext } from "react";
import type { Translate } from "./i18n";

export const I18nContext = createContext<Translate>((text) => text);

/** The component-side hook: `const t = useT(); … t("Sign out")`. */
export const useT = (): Translate => useContext(I18nContext);
