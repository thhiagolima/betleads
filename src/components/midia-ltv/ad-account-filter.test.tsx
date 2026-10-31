import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { account } from "@/components/integrations/meta/meta-test-fixtures";
import {
  AD_ACCOUNT_FILTER_NOTE,
  AdAccountFilter,
  AdAccountFilterNote,
  adAccountFilterLabel,
  adAccountGroups,
  toggleAdAccounts,
} from "./ad-account-filter";

const accounts = [
  account({ id: "a1", meta_ad_account_id: "act_1", name: "Captação 01", selected: true }),
  account({
    id: "a2",
    meta_ad_account_id: "act_2",
    name: "Remarketing",
    business_name: "Agência X",
    selected: true,
  }),
  account({ id: "a3", meta_ad_account_id: "act_3", name: "Fora", selected: false }),
  account({
    id: "a4",
    meta_ad_account_id: "act_4",
    name: null,
    business_name: null,
    selected: true,
  }),
];

describe("adAccountGroups", () => {
  it("groups only the selected accounts by BM name, 'Sem BM' last", () => {
    const groups = adAccountGroups(accounts);
    expect(groups.map((group) => group.business)).toEqual(["Agência X", "Sorte Alta", "Sem BM"]);
    expect(groups.flatMap((group) => group.options.map((option) => option.id))).toEqual([
      "act_2",
      "act_1",
      "act_4",
    ]);
    // Sem nome, a conta aparece pelo act_.
    expect(groups[2].options[0].name).toBe("act_4");
  });
});

describe("AdAccountFilter", () => {
  it("defaults to 'Todas as contas' and names the chosen accounts", () => {
    const options = adAccountGroups(accounts).flatMap((group) => group.options);
    expect(adAccountFilterLabel([], options)).toBe("Todas as contas");
    expect(adAccountFilterLabel(["act_2"], options)).toBe("Remarketing");
    expect(adAccountFilterLabel(["act_1", "act_2"], options)).toBe("2 contas");

    const html = renderToStaticMarkup(
      <AdAccountFilter accounts={accounts} value={[]} onChange={() => undefined} />,
    );
    expect(html).toContain("BM / conta:");
    expect(html).toContain("Todas as contas");
  });

  it("keeps an explicit list as a filter even when every account is ticked", () => {
    let value: string[] = [];
    for (const id of ["act_1", "act_2", "act_4"]) value = toggleAdAccounts(value, [id]);
    // Todas marcadas uma a uma não viram "Todas as contas".
    expect(value).toEqual(["act_1", "act_2", "act_4"]);
    const options = adAccountGroups(accounts).flatMap((group) => group.options);
    expect(adAccountFilterLabel(value, options)).toBe("3 contas");
    // Desmarcar tira só aquela conta; a BM inteira alterna em bloco.
    expect(toggleAdAccounts(value, ["act_2"])).toEqual(["act_1", "act_4"]);
    expect(toggleAdAccounts(["act_1"], ["act_1", "act_2"])).toEqual(["act_1", "act_2"]);
    expect(toggleAdAccounts(["act_1", "act_2"], ["act_1", "act_2"])).toEqual([]);
  });

  it("is hidden when no account is selected", () => {
    const html = renderToStaticMarkup(
      <AdAccountFilter
        accounts={[account({ selected: false })]}
        value={[]}
        onChange={() => undefined}
      />,
    );
    expect(html).toBe("");
  });

  it("shows the matched-only note only when a filter is active", () => {
    expect(renderToStaticMarkup(<AdAccountFilterNote active={false} />)).toBe("");
    const html = renderToStaticMarkup(<AdAccountFilterNote active />);
    expect(html).toContain(AD_ACCOUNT_FILTER_NOTE);
    expect(AD_ACCOUNT_FILTER_NOTE).toBe(
      "Com filtro, entram só os jogadores atribuídos a essas contas; tráfego sem atribuição fica de fora.",
    );
  });
});
