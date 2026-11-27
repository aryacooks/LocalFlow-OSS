import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Link, MemoryRouter, Route, Routes } from "react-router-dom";
import { expect, it, vi } from "vitest";
import UpdateCard from "./UpdateCard";

const api = vi.hoisted(() => ({
  checkUpdate: vi.fn(),
  installUpdate: vi.fn(),
  relaunch: vi.fn(),
  listen: vi.fn(),
}));
vi.mock("../lib/ipc", () => api);
vi.mock("@tauri-apps/api/event", () => ({ listen: api.listen }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: api.relaunch }));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: async () => "1.0.0" }));

it("keeps one download and restart across About navigation", async () => {
  api.checkUpdate.mockResolvedValue({ current: "1.0.0", latest: "1.0.1", available: true });
  let complete!: () => void;
  api.installUpdate.mockImplementation(() => new Promise<void>(resolve => { complete = resolve; }));
  const unsubscribe = vi.fn();
  api.listen.mockResolvedValue(unsubscribe);
  render(<MemoryRouter initialEntries={["/about"]}>
    <Link to="/about">About</Link><Link to="/history">History</Link>
    <Routes>
      <Route path="/about" element={<UpdateCard />} />
      <Route path="/history" element={<p>Dictation history</p>} />
    </Routes>
  </MemoryRouter>);

  fireEvent.click(await screen.findByRole("button", { name: "Update and restart" }));
  await waitFor(() => expect(api.installUpdate).toHaveBeenCalledOnce());
  const navigate = (name: string) => fireEvent.click(screen.getByRole("link", { name }));
  navigate("History");
  act(() => api.listen.mock.calls[0][1]({ payload: [35, 100] }));
  navigate("About");
  expect(await screen.findByText("Downloading… 35%")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Update and restart" })).toBeNull();
  navigate("History");
  await act(async () => complete());
  navigate("About");
  expect(await screen.findByText("Restarting LocalFlow…")).toBeTruthy();
  expect(api.checkUpdate).toHaveBeenCalledOnce();
  expect(api.installUpdate).toHaveBeenCalledOnce();
  expect(api.relaunch).toHaveBeenCalledOnce();
  expect(unsubscribe).toHaveBeenCalledOnce();
});
