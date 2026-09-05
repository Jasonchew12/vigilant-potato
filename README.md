# Shopee Variation Import & Export Tools v2.3.1

This Tampermonkey userscript adds a panel above **Variation List** in Shopee Seller Centre. If that section has not loaded yet, the panel appears at the bottom-right.

When Shopee shows **View All (...)** below the variation table, the script automatically clicks it. It checks again before Excel/CSV export and before applying changes. The browser console records the click with the `[Shopee Variation Tools]` prefix.

## Public product pages

The script also runs on public `shopee.com.my` product pages. The export panel appears below **Add to Cart / Buy Now** when those controls are found. It includes **Scan Price & Stock**, **Stop Scan**, **Export Excel**, **Export CSV**, and **Copy CSV**. It automatically opens the **Variations Available** selector when needed.

If Shopee initially shows only **“Variations Available”**, the script opens that selector before scanning. Once **Add to Cart** and **Buy Now** are present, it moves the export panel directly below those buttons.

- **Scan Price & Stock** checks every variation in order. Disabled choices are recorded as Stock `0`; each available choice is selected and its current selling price plus any displayed **“N piece(s) available”** quantity are captured.
- The scanner confirms the selected button and waits for the price/quantity display to stabilize, preventing values from the previous variation from being reused.
- Quantity text is read from Shopee's **Quantity** section, not from unrelated parts of the page.
- Export Excel, Export CSV, and Copy CSV automatically start the scan first when available choices have not yet been checked.
- The original selected variation is restored after a completed scan when possible.
- If Shopee does not display an exact quantity for an available choice, its Stock remains blank rather than using the unreliable embedded public `stock` value.
- The scanner ignores crossed-out original prices and exports the current `RM`/`MYR` selling price. If no exact single price is visible, Price remains blank rather than exporting a range or guessing.
- Public mode never imports or edits anything.
- The generated Excel file still has the Action dropdown, so it can later be imported from the Seller Centre page.
- Progress and captured quantities are recorded in the panel and browser console. A 98-variation scan can take a few minutes because the scanner waits for each Shopee update to settle.

## Install

1. Install the Tampermonkey browser extension.
2. Open Tampermonkey and choose **Create a new script**.
3. Remove its sample code, paste all of `shopee-variation-tools.user.js`, and save.
4. Open the Shopee Seller Centre product edit page and reload it.
5. In the browser console, look for messages beginning with `[Shopee Variation Tools]`.

## Excel and CSV columns

`Action,Current Variation Name,New Variation Name,Price,Stock,Image URL`

- `KEEP`: makes no changes. This is the default action.
- `UPDATE`: Current Variation Name must exactly match Shopee. New Variation Name is optional. Blank Price or Stock keeps the current value. A blank Image URL REMOVES the existing variation image; a supplied URL uploads an image.
- `ADD`: New Variation Name, Price, and Stock are required. Image URL is optional.
- Names are limited to 20 characters.
- The final listing is limited to 100 variations.
- Deleting variation rows is intentionally not supported. UPDATE with blank Image URL removes only the variation image.

Both `.xlsx` and `.csv` files can be imported. **Export Excel** creates a ready-to-edit workbook with 100 rows and Action dropdowns. The Excel feature loads the pinned ExcelJS 4.4.0 browser library automatically through Tampermonkey, so the Seller Centre computer needs internet access when the script starts.

## Images

For UPDATE rows, blank Image URL means remove the existing image. KEEP rows leave images unchanged; ADD rows may omit an image. Export leaves Image URL blank, so changing an exported row to UPDATE also requests image removal unless you supply a URL. Preview and Apply confirmation show this behavior. Removal uses Shopee's per-image delete control and stops apply mode if removal cannot be confirmed.

Only direct, public `http://` or `https://` image links are supported. The script downloads a supplied link only after you click **Apply Changes** and confirm. The broad Tampermonkey `@connect *` permission is required because image links may come from different websites. Existing Shopee images are never downloaded or included in Export CSV.

## Safe workflow

1. Open the correct Shopee product edit page and slowly scroll through the variation table once.
2. Click **Export Excel**. The exported workbook already contains the current names, available price/stock values, and Action dropdowns.
3. Edit and save that same `.xlsx` file.
4. Click **Import CSV/Excel**, choose the file, then click **Preview**.
5. Click **Apply Changes** and confirm.
6. Slowly scroll through the entire variation table. Shopee renders rows in batches, so price, stock, and image changes are applied as rows appear.
7. Review everything and click Shopee's Save button yourself only when satisfied.

The CSV buttons remain available for lightweight exports, clipboard use, or compatibility with other systems. CSV cannot contain dropdown menus; Excel can.

The script never clicks Shopee Save. Use **Stop** to stop processing newly rendered rows. You can also use **Copy CSV** to copy the current export to the clipboard.

Shopee may change its page HTML at any time. Test with a small number of changes first.
