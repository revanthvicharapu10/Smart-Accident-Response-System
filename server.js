const express = require("express");
const cors = require("cors");
const path = require("path");
const db = require("./db");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({limit:"5mb"}));
app.use(express.static(path.join(__dirname,"public")));

function distanceKm(lat1,lon1,lat2,lon2){
  const R=6371, rad=d=>d*Math.PI/180;
  const dLat=rad(lat2-lat1), dLon=rad(lon2-lon1);
  const a=Math.sin(dLat/2)**2+Math.cos(rad(lat1))*Math.cos(rad(lat2))*Math.sin(dLon/2)**2;
  return R*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));
}

function verifyAccident(a){
  let score=0;
  if(Number.isFinite(a.latitude)&&Number.isFinite(a.longitude))score+=30;
  if((a.description||"").trim().length>=10)score+=20;
  if(a.severity&&a.severity!=="Unknown")score+=15;
  if(a.confirmations>=1)score+=20;
  if(a.photoProvided)score+=15;
  if(score>=70)return{status:"Probably Real",score};
  if(score>=45)return{status:"Needs Verification",score};
  return{status:"Fake-Suspected",score};
}

/* Demo vehicles are placed around the user's current location.
   This makes the student demo responsive to any GPS location. */
function virtualVehicle(v,lat,lon,index){
  const offsets=[
    [0.012,0.006],[-0.008,0.011],[0.006,-0.014],[-0.014,-0.006],[0.010,-0.012]
  ];
  const o=offsets[index%offsets.length];
  return {...v,latitude:lat+o[0],longitude:lon+o[1],demo_location:true};
}

app.get("/api/health",(req,res)=>res.json({ok:true}));

app.get("/api/vehicles",(req,res)=>{
  res.json(db.prepare("SELECT * FROM vehicles ORDER BY type,id").all());
});

app.get("/api/vehicles/nearest",(req,res)=>{
  const lat=Number(req.query.lat),lon=Number(req.query.lon),type=req.query.type;
  if(!Number.isFinite(lat)||!Number.isFinite(lon))
    return res.status(400).json({error:"Valid latitude and longitude are required."});
  let sql=type?"SELECT * FROM vehicles WHERE status='Available' AND type=?":
                "SELECT * FROM vehicles WHERE status='Available'";
  let raw=db.prepare(sql).all(...(type?[type]:[]));
  raw=raw.map((v,i)=>virtualVehicle(v,lat,lon,i));
  const vehicles=raw.map(v=>{
    const d=distanceKm(lat,lon,v.latitude,v.longitude);
    return {...v,distance_km:Number(d.toFixed(2)),eta_min:Math.max(2,Math.round(d*3.2))};
  }).sort((a,b)=>a.distance_km-b.distance_km);
  res.json(vehicles);
});

/* Real nearby hospital search using OpenStreetMap Overpass.
   Falls back to the local demo DB if the public service is unavailable. */
app.get("/api/hospitals",(req,res)=>{
  const lat=Number(req.query.lat),lon=Number(req.query.lon),radius=Number(req.query.radius||10000);
  if(!Number.isFinite(lat)||!Number.isFinite(lon))
    return res.json(db.prepare("SELECT * FROM hospitals").all());

  const query=`[out:json][timeout:12];
(
  node["amenity"="hospital"](around:${Math.min(Math.max(radius,1000),15000)},${lat},${lon});
  way["amenity"="hospital"](around:${Math.min(Math.max(radius,1000),15000)},${lat},${lon});
  relation["amenity"="hospital"](around:${Math.min(Math.max(radius,1000),15000)},${lat},${lon});
);
out center tags;`;

  fetch("https://overpass-api.de/api/interpreter",{
    method:"POST",
    headers:{"Content-Type":"application/x-www-form-urlencoded"},
    body:"data="+encodeURIComponent(query)
  }).then(async r=>{
    if(!r.ok)throw new Error("Overpass unavailable");
    return r.json();
  }).then(data=>{
    const hospitals=(data.elements||[]).map((e,i)=>{
      const h=e.tags||{};
      const hlat=e.lat ?? e.center?.lat, hlon=e.lon ?? e.center?.lon;
      if(!Number.isFinite(hlat)||!Number.isFinite(hlon))return null;
      const d=distanceKm(lat,lon,hlat,hlon);
      return {
        id:"osm-"+e.type+"-"+e.id,
        name:h.name||"Unnamed Hospital",
        latitude:hlat,longitude:hlon,
        distance_km:Number(d.toFixed(2)),
        eta_min:Math.max(2,Math.round(d*3)),
        emergency_available: h.emergency==="no"?0:1,
        phone:h.phone||h["contact:phone"]||"",
        source:"OpenStreetMap"
      };
    }).filter(Boolean).sort((a,b)=>a.distance_km-b.distance_km).slice(0,12);
    if(hospitals.length)return res.json(hospitals);
    throw new Error("No nearby hospitals");
  }).catch(()=>{
    const fallback=db.prepare("SELECT * FROM hospitals").all().map(h=>{
      const d=distanceKm(lat,lon,h.latitude,h.longitude);
      return {...h,distance_km:Number(d.toFixed(2)),eta_min:Math.max(2,Math.round(d*3))};
    }).sort((a,b)=>a.distance_km-b.distance_km).slice(0,12);
    res.json(fallback);
  });
});

app.get("/api/route",async(req,res)=>{
  const fl=Number(req.query.fromLat),fn=Number(req.query.fromLon);
  const tl=Number(req.query.toLat),tn=Number(req.query.toLon);
  if([fl,fn,tl,tn].some(x=>!Number.isFinite(x)))
    return res.status(400).json({error:"Invalid route coordinates"});
  try{
    const url=`https://router.project-osrm.org/route/v1/driving/${fn},${fl};${tn},${tl}?overview=full&geometries=geojson`;
    const r=await fetch(url);
    if(!r.ok)throw new Error("OSRM unavailable");
    const data=await r.json();
    if(!data.routes?.[0])throw new Error("No route");
    const route=data.routes[0];
    res.json({source:"OSRM",distance_km:Number((route.distance/1000).toFixed(2)),
      eta_min:Math.max(1,Math.round(route.duration/60)),geometry:route.geometry});
  }catch(e){
    const d=distanceKm(fl,fn,tl,tn);
    res.json({source:"straight-line-demo",distance_km:Number(d.toFixed(2)),
      eta_min:Math.max(2,Math.round(d*3.2)),
      geometry:{type:"LineString",coordinates:[[fn,fl],[tn,tl]]}});
  }
});

app.post("/api/accidents",(req,res)=>{
  const {latitude,longitude,description="",severity="Unknown",confirmations=0,photoProvided=false}=req.body;
  if(!Number.isFinite(Number(latitude))||!Number.isFinite(Number(longitude)))
    return res.status(400).json({error:"Valid accident coordinates are required."});
  const v=verifyAccident({latitude:Number(latitude),longitude:Number(longitude),description,severity,
    confirmations:Number(confirmations),photoProvided:Boolean(photoProvided)});
  const r=db.prepare(`INSERT INTO accidents
    (latitude,longitude,description,severity,verification_status,verification_score,confirmations)
    VALUES (?,?,?,?,?,?,?)`).run(Number(latitude),Number(longitude),description,severity,v.status,v.score,Number(confirmations));
  res.status(201).json(db.prepare("SELECT * FROM accidents WHERE id=?").get(r.lastInsertRowid));
});

app.get("/api/accidents",(req,res)=>res.json(db.prepare("SELECT * FROM accidents ORDER BY created_at DESC").all()));

app.post("/api/dispatch",(req,res)=>{
  const accident=db.prepare("SELECT * FROM accidents WHERE id=?").get(req.body.accidentId);
  const vehicle=db.prepare("SELECT * FROM vehicles WHERE id=?").get(req.body.vehicleId);
  if(!accident||!vehicle)return res.status(404).json({error:"Accident or vehicle not found."});

  const vl=Number(req.body.vehicleLat),vn=Number(req.body.vehicleLon);
  const fromLat=Number.isFinite(vl)?vl:vehicle.latitude;
  const fromLon=Number.isFinite(vn)?vn:vehicle.longitude;
  const d=distanceKm(accident.latitude,accident.longitude,fromLat,fromLon);
  const eta=Math.max(2,Math.round(d*3.2));

  db.prepare("UPDATE vehicles SET status='Dispatched' WHERE id=?").run(vehicle.id);
  const r=db.prepare(`INSERT INTO dispatches(accident_id,vehicle_id,distance_km,eta_min,status)
    VALUES(?,?,?,?,?)`).run(accident.id,vehicle.id,Number(d.toFixed(2)),eta,"Dispatched");

  res.json({id:r.lastInsertRowid,vehicle_id:vehicle.id,vehicle_type:vehicle.type,
    vehicle_number:vehicle.vehicle_number,distance_km:Number(d.toFixed(2)),eta_min:eta,status:"Dispatched",
    fromLat,fromLon,toLat:accident.latitude,toLon:accident.longitude});
});

app.get("/api/dispatches",(req,res)=>res.json(db.prepare(`SELECT d.*,v.type,v.vehicle_number
  FROM dispatches d JOIN vehicles v ON v.id=d.vehicle_id ORDER BY d.created_at DESC`).all()));

app.get("*",(req,res)=>res.sendFile(path.join(__dirname,"public","index.html")));

if (require.main === module) {
  app.listen(PORT,()=>console.log(`Smart Accident Response System running at http://localhost:${PORT}`));
}

module.exports = app;