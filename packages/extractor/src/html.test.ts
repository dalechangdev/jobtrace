import { describe, expect, it } from "vitest";
import { decodeEntities, htmlToText } from "./html.ts";

describe("decodeEntities", () => {
  it("decodes named, decimal and hex references and leaves unknown ones alone", () => {
    expect(decodeEntities("&lt;p&gt;R&amp;D &#8211; &#x2014; &euro;90k&nbsp;&bogus; &#0;")).toBe(
      "<p>R&D – — €90k &bogus; &#0;",
    );
  });
});

describe("htmlToText", () => {
  it("turns blocks into lines and list items into dashes", () => {
    const html = `<div class="intro"><p>We build <b>robots</b>.</p><p>Join&nbsp;us!</p></div>
      <h3>Requirements</h3><ul><li>Rust</li><li>C++ &amp; Python</li></ul><p>Apply<br>now</p>`;
    expect(htmlToText(html)).toBe(
      "We build robots.\n\nJoin us!\n\nRequirements\n\n- Rust\n- C++ & Python\n\nApply\nnow",
    );
  });

  it("drops scripts, styles and comments, and survives plain text", () => {
    expect(
      htmlToText("<style>p{color:red}</style>Hi<!-- note --><script>alert(1)</script> there"),
    ).toBe("Hi there");
    expect(htmlToText("just text")).toBe("just text");
    expect(htmlToText("")).toBe("");
  });
});
