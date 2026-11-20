// Settings → Remove LocalFlow: selection, confirmation gating, cancel, results.
// The backend (src/lib/ipc) is mocked: nothing is deleted or uninstalled here.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const ipc = vi.hoisted(() => ({
  removalSupport: vi.fn(),
  removeLocalflow: vi.fn(),
}));
vi.mock("../lib/ipc", () => ipc);

import RemoveLocalFlow, { REMOVE_CHOICES } from "./RemoveLocalFlow";

const ok = { data_deleted: false, app_removed: false, error: null };

beforeEach(() => {
  ipc.removalSupport.mockResolvedValue({ app_removable: true, reason: null });
  ipc.removeLocalflow.mockReset();
});
afterEach(cleanup);

async function pick(user: ReturnType<typeof userEvent.setup>, label: string) {
  await user.click(screen.getByRole("button", { name: "What to remove" }));
  await user.click(screen.getByRole("option", { name: label }));
}

describe("Remove LocalFlow", () => {
  it("defaults to deleting the app and transcription data", async () => {
    render(<RemoveLocalFlow />);
    expect(screen.getByRole("button", { name: "What to remove" }).textContent).toContain("Delete app and transcription data");
    expect(screen.getByText(REMOVE_CHOICES.app_and_data.explain)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Delete app and data/ })).toBeTruthy();
  });

  it("updates the explanation and button with the selection, without deleting anything", async () => {
    const user = userEvent.setup();
    render(<RemoveLocalFlow />);
    await pick(user, "Delete app only");
    expect(screen.getByText(REMOVE_CHOICES.app_only.explain)).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Delete app$/ })).toBeTruthy();
    await pick(user, "Delete transcription data only");
    expect(screen.getByText(REMOVE_CHOICES.data_only.explain)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Delete transcription data/ })).toBeTruthy();
    expect(ipc.removeLocalflow).not.toHaveBeenCalled();
  });

  it("opens a confirmation with Cancel focused; Cancel and Esc delete nothing", async () => {
    const user = userEvent.setup();
    render(<RemoveLocalFlow />);
    await user.click(screen.getByRole("button", { name: /Delete app and data/ }));
    const dialog = screen.getByRole("alertdialog");
    expect(dialog).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cancel" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();

    await user.click(screen.getByRole("button", { name: /Delete app and data/ }));
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(ipc.removeLocalflow).not.toHaveBeenCalled();
  });

  for (const [label, choice, button] of [
    ["Delete app and transcription data", "app_and_data", "Delete app and data"],
    ["Delete transcription data only", "data_only", "Delete transcription data"],
  ] as const) {
    it(`requires typing DELETE for "${label}"`, async () => {
      const user = userEvent.setup();
      ipc.removeLocalflow.mockResolvedValue({ ...ok, data_deleted: true, app_removed: choice === "app_and_data" });
      render(<RemoveLocalFlow />);
      if (choice !== "app_and_data") await pick(user, label);
      await user.click(screen.getByRole("button", { name: new RegExp(button) }));
      const confirm = () => screen.getAllByRole("button", { name: button }).find((b) => b.closest("[role=alertdialog]"))!;
      expect((confirm() as HTMLButtonElement).disabled).toBe(true);
      expect(screen.getByText(/can't be undone/)).toBeTruthy();
      const input = screen.getByLabelText("Type DELETE to confirm");
      await user.type(input, "delete");
      expect((confirm() as HTMLButtonElement).disabled).toBe(true);
      await user.clear(input);
      await user.type(input, "DELETE");
      expect((confirm() as HTMLButtonElement).disabled).toBe(false);
      await user.click(confirm());
      expect(ipc.removeLocalflow).toHaveBeenCalledWith(choice);
    });
  }

  it("app only needs no typing", async () => {
    const user = userEvent.setup();
    ipc.removeLocalflow.mockResolvedValue({ ...ok, app_removed: true });
    render(<RemoveLocalFlow />);
    await pick(user, "Delete app only");
    await user.click(screen.getByRole("button", { name: /^Delete app$/ }));
    expect(screen.queryByLabelText("Type DELETE to confirm")).toBeNull();
    const confirm = screen.getAllByRole("button", { name: "Delete app" }).find((b) => b.closest("[role=alertdialog]"))!;
    await user.click(confirm);
    expect(ipc.removeLocalflow).toHaveBeenCalledWith("app_only");
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("moved to Trash"));
  });

  it("reports a partial failure honestly", async () => {
    const user = userEvent.setup();
    const error = "Your transcriptions were deleted, but LocalFlow is still installed: it couldn't be moved to the Trash (permission denied).";
    ipc.removeLocalflow.mockResolvedValue({ data_deleted: true, app_removed: false, error });
    render(<RemoveLocalFlow />);
    await user.click(screen.getByRole("button", { name: /Delete app and data/ }));
    await user.type(screen.getByLabelText("Type DELETE to confirm"), "DELETE");
    await user.click(screen.getAllByRole("button", { name: "Delete app and data" }).find((b) => b.closest("[role=alertdialog]"))!);
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe(error));
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("explains when the app can't be removed from here, but still allows deleting data", async () => {
    const user = userEvent.setup();
    ipc.removalSupport.mockResolvedValue({ app_removable: false, reason: "This is a development build, so there's no installed LocalFlow app to remove." });
    render(<RemoveLocalFlow />);
    await waitFor(() => expect(screen.getByText(/development build/)).toBeTruthy());
    expect((screen.getByRole("button", { name: /Delete app and data/ }) as HTMLButtonElement).disabled).toBe(true);
    await pick(user, "Delete transcription data only");
    expect((screen.getByRole("button", { name: /Delete transcription data/ }) as HTMLButtonElement).disabled).toBe(false);
  });
});
