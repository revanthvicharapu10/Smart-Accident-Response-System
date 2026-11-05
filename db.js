// In-memory database adapter compatible with the better-sqlite3 API
// Zero native C++ dependencies — runs seamlessly on Vercel, Linux, macOS, and Windows.

const data = {
  accidents: [],
  vehicles: [
    { id: 1, vehicle_number: "AP-AMB-101", type: "Ambulance", latitude: 15.8230, longitude: 80.3510, status: "Available" },
    { id: 2, vehicle_number: "AP-AMB-102", type: "Ambulance", latitude: 15.8265, longitude: 80.3490, status: "Available" },
    { id: 3, vehicle_number: "AP-FIRE-201", type: "Fire Engine", latitude: 15.8200, longitude: 80.3550, status: "Available" },
    { id: 4, vehicle_number: "AP-POL-301", type: "Police", latitude: 15.8250, longitude: 80.3570, status: "Available" },
    { id: 5, vehicle_number: "AP-POL-302", type: "Police", latitude: 15.8185, longitude: 80.3470, status: "Available" }
  ],
  hospitals: [
    ["Government General Hospital (Demo)", 15.8285, 80.3505, 1, "108"],
    ["City Care Hospital (Demo)", 15.8175, 80.3535, 1, "08643-000000"],
    ["LifeLine Emergency Hospital (Demo)", 15.8310, 80.3600, 1, "08643-111111"]
  ].map(([name, latitude, longitude, emergency_available, phone], idx) => ({
    id: idx + 1, name, latitude, longitude, emergency_available, phone
  })),
  dispatches: []
};

let accidentIdSeq = 1;
let dispatchIdSeq = 1;

function prepare(sql) {
  const norm = sql.trim().replace(/\s+/g, " ");

  return {
    all(...args) {
      if (/SELECT \* FROM vehicles ORDER BY type,id/i.test(norm)) {
        return [...data.vehicles].sort((a, b) => a.type.localeCompare(b.type) || a.id - b.id);
      }
      if (/SELECT \* FROM vehicles WHERE status='Available' AND type=\?/i.test(norm)) {
        return data.vehicles.filter(v => v.status === "Available" && v.type === args[0]);
      }
      if (/SELECT \* FROM vehicles WHERE status='Available'/i.test(norm)) {
        return data.vehicles.filter(v => v.status === "Available");
      }
      if (/SELECT \* FROM vehicles/i.test(norm)) {
        return [...data.vehicles];
      }
      if (/SELECT \* FROM hospitals/i.test(norm)) {
        return [...data.hospitals];
      }
      if (/SELECT \* FROM accidents ORDER BY created_at DESC/i.test(norm)) {
        return [...data.accidents];
      }
      if (/SELECT d\.\*,v\.type,v\.vehicle_number FROM dispatches d/i.test(norm)) {
        return data.dispatches.map(d => {
          const v = data.vehicles.find(x => x.id === d.vehicle_id) || {};
          return { ...d, type: v.type, vehicle_number: v.vehicle_number };
        });
      }
      return [];
    },

    get(...args) {
      if (/SELECT COUNT\(\*\) c FROM vehicles/i.test(norm)) {
        return { c: data.vehicles.length };
      }
      if (/SELECT COUNT\(\*\) c FROM hospitals/i.test(norm)) {
        return { c: data.hospitals.length };
      }
      if (/SELECT \* FROM accidents WHERE id=\?/i.test(norm)) {
        return data.accidents.find(a => a.id === Number(args[0])) || null;
      }
      if (/SELECT \* FROM vehicles WHERE id=\?/i.test(norm)) {
        return data.vehicles.find(v => v.id === Number(args[0])) || null;
      }
      return null;
    },

    run(...args) {
      if (/INSERT INTO accidents/i.test(norm)) {
        const [latitude, longitude, description, severity, verification_status, verification_score, confirmations] = args;
        const id = accidentIdSeq++;
        const row = {
          id,
          latitude: Number(latitude),
          longitude: Number(longitude),
          description: description || "",
          severity: severity || "Unknown",
          verification_status: verification_status || "Needs Verification",
          verification_score: Number(verification_score || 0),
          confirmations: Number(confirmations || 0),
          created_at: new Date().toISOString().replace("T", " ").substring(0, 19)
        };
        data.accidents.unshift(row);
        return { lastInsertRowid: id, changes: 1 };
      }

      if (/UPDATE vehicles SET status='Dispatched' WHERE id=\?/i.test(norm)) {
        const id = Number(args[0]);
        const v = data.vehicles.find(x => x.id === id);
        if (v) v.status = "Dispatched";
        return { changes: v ? 1 : 0 };
      }

      if (/INSERT INTO dispatches/i.test(norm)) {
        const [accident_id, vehicle_id, distance_km, eta_min, status] = args;
        const id = dispatchIdSeq++;
        const row = {
          id,
          accident_id: Number(accident_id),
          vehicle_id: Number(vehicle_id),
          distance_km: Number(distance_km),
          eta_min: Number(eta_min),
          status: status || "Dispatched",
          created_at: new Date().toISOString().replace("T", " ").substring(0, 19)
        };
        data.dispatches.unshift(row);
        return { lastInsertRowid: id, changes: 1 };
      }

      return { changes: 0, lastInsertRowid: 0 };
    }
  };
}

module.exports = {
  prepare,
  pragma() {},
  exec() {},
  transaction(fn) { return fn; }
};
