import { streamResponse } from "@/lib/stream-response";
import { requireAccess } from "@/lib/auth-access";
import { requestErrorResponse } from "@/lib/request-security";
import { NextRequest } from "next/server";
import { getScannedDemandExport } from "@/db/cart-store";
import { serializeCsvCell } from "@/lib/csv";

const EXPORT_COLUMNS = [
  ["source_line_id", "Source Line ID"], ["source_scope", "Source Scope"],
  ["unit_of_measure", "Unit of Measure"], ["preferred_supplier_id", "Preferred Supplier ID"],
  ["inventory_supplier_id", "Inventory Supplier ID"],
  ["dispatched_at", "Dispatched At"], ["dispatched_by", "Dispatched By"],
  ["production_quantity", "Production Quantity"], ["cart_max_quantity", "Cart Max Quantity"],
  ["interior_color", "Interior Color"], ["exterior_color", "Exterior Color"], ["vehicle_color", "Vehicle Color"],
  ["import_batch_id", "Import Batch ID"], ["file_name", "Source File"],
  ["imported_at", "Imported At"], ["is_active", "Active Batch"],
  ["program_id", "Program ID"], ["plant", "Plant"], ["zone", "Zone"],
  ["area_type", "Area"], ["ship_category", "Ship Category"],
  ["load_number", "Load #"], ["train_number", "Train #"],
  ["picklist_number", "Picklist #"], ["cart_number", "Cart #"],
  ["cart_id", "Cart ID"], ["pallet_id", "Pallet ID"],
  ["cart_barcode", "PPA Cart ID"], ["loaded_at", "Loaded At"],
  ["loaded_by", "Loaded By"], ["loaded_destination_scan", "Loaded Destination Scan"],
  ["loading_confirmed_at", "Loading Confirmed At"], ["loading_is_test", "Loading Test Record"],
  ["total_carts", "Total Carts"], ["pymtc", "P/Y/MTC"],
  ["checksheet_number", "Checksheet #"], ["master_barcode", "Master Barcode"],
  ["movement_barcode", "Movement Barcode"], ["case_code", "Case Code"],
  ["outgoing_serial", "O/G Serial"], ["cart_sequence_number", "Cart Sequence"],
  ["from_lot", "From Lot"], ["to_lot", "To Lot"], ["model", "Model"],
  ["cart_type", "Cart Type"], ["scheduled_dispatch_date", "Dispatch Date"],
  ["scheduled_dispatch_time", "Dispatch Time"], ["delivery_location", "Delivery Location"],
  ["chassis_number", "Chassis #"], ["order_number", "Order #"],
  ["batch_number", "Batch #"], ["loading_sequence", "Loading Sequence"],
  ["line_id", "Demand Line ID"], ["sequence", "Part Sequence"], ["pack_sequence", "Pack Sequence"],
  ["option_text", "Option"], ["short_closed_at", "Closed Short At"],
  ["fulfilled_at", "Filled At"], ["fulfilled_by", "Filled By"],
  ["remaining_quantity", "Remaining Quantity"], ["allocations_json", "Container Allocations JSON"],
  ["part_number", "Part #"], ["description", "Description"], ["color", "Part Mark"],
  ["quantity", "Required Quantity"], ["fulfilled_quantity", "Fulfilled Quantity"],
  ["aiag_serial", "Inventory Serial Number"], ["inventory_item_id", "Inventory ID"],
  ["legacy_expected_serial", "Legacy Expected Serial (History Only)"],
  ["detail_delivery_location", "Detail Delivery Location"],
  ["container_position", "Container Position"], ["container_type", "Container Type"],
  ["container_sequence", "Container sequence"],
  ["from_model", "From Model"], ["from_type", "From Type"], ["from_option", "From Option"],
  ["from_color", "From Color"], ["from_interior_color", "From Interior Color"], ["from_units", "From Units"],
  ["to_model", "To Model"], ["to_type", "To Type"], ["to_option", "To Option"],
  ["to_color", "To Color"], ["to_interior_color", "To Interior Color"], ["to_units", "To Units"],
  ["picking_location", "Picking Location"], ["mcid", "MCID"],
  ["container_total", "Container Total"], ["status", "Demand Status"],
  ["verified_at", "Verified At"], ["scan_event_id", "Scan Event ID"],
  ["scan_field", "Scan Field"], ["scanned_value", "Scanned Value"],
  ["matched", "Matched"], ["operator_name", "Operator"], ["scanned_at", "Scanned At"],
  ["is_test", "Test Record"], ["operator_id", "Operator ID"],
  ["scan_invalidated_at", "Scan Evidence Invalidated At"],
  ["loading_operator_id", "Loading Operator ID"],
] as const;

function serializeScannedDemandCsv(rows: Array<Record<string, unknown>>) {
  return [
    EXPORT_COLUMNS.map(([, label]) => serializeCsvCell(label)).join(","),
    ...rows.map((row) => EXPORT_COLUMNS.map(([key]) => serializeCsvCell(row[key])).join(",")),
  ].join("\r\n");
}

async function handleGET(request: NextRequest) {
  try {
    const scope = request.nextUrl.searchParams.get("scope") === "history" ? "history" : "active";
    const rows = await getScannedDemandExport(scope);
    const date = new Date().toISOString().slice(0, 10);
    return streamResponse(`\uFEFF${serializeScannedDemandCsv(rows)}`, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="ppa-scans-${scope}-${date}.csv"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return requestErrorResponse(error, "Unable to export scanned demand.");
  }
}

export async function GET(request: NextRequest) {
  const access = await requireAccess(request, "viewer");
  if (access instanceof Response) return access;
  try { return await handleGET(request); }
  catch (error) { return requestErrorResponse(error, "Unable to complete this request."); }
}
