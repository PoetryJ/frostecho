// The shared fog, reverse depth and HDR composition follow Abyssal Garden's architecture.
// Snow materials, height fog, local warm lighting and particle motion are adapted for land.
export const GLOBAL = /* wgsl */ `
struct Globals {
  vp:mat4x4f, shadow:mat4x4f,
  cam:vec4f, right:vec4f, up:vec4f, forward:vec4f,
  sun:vec4f, light:vec4f, skyLow:vec4f, skyHigh:vec4f,
  fog:vec4f, params:vec4f, res:vec4f, hero:vec4f,
  lights:array<vec4f,32>, chimney:vec4f
};
@group(0) @binding(0) var<uniform> g:Globals;
fn sat(x:f32)->f32{return clamp(x,0.,1.);}
fn hash(p:vec3f)->f32{var q=fract(p*.1031);q+=dot(q,q.yzx+33.33);return fract((q.x+q.y)*q.z);}
fn noise(p:vec3f)->f32{
 let i=floor(p);let f=fract(p);let u=f*f*(3.-2.*f);
 return mix(mix(mix(hash(i),hash(i+vec3f(1,0,0)),u.x),mix(hash(i+vec3f(0,1,0)),hash(i+vec3f(1,1,0)),u.x),u.y),mix(mix(hash(i+vec3f(0,0,1)),hash(i+vec3f(1,0,1)),u.x),mix(hash(i+vec3f(0,1,1)),hash(i+vec3f(1,1,1)),u.x),u.y),u.z);
}
fn sky(rd:vec3f)->vec3f{
 let h=sat(rd.y*.8+.2);var c=mix(g.skyLow.rgb,g.skyHigh.rgb,h);
 let clouds=noise(rd*6.+vec3f(g.cam.w*.008,0,0));c*=.85+.30*clouds;
 let sun=pow(sat(dot(rd,g.sun.xyz)),64.);c+=g.light.rgb*sun*.20;
 return c;
}
fn fogIntegral(y:f32,dy:f32,d:f32)->f32{
 let a=.055*dy;
 let I=select((1.-exp(clamp(-a*d,-25.,25.)))/select(a,1e-5,abs(a)<1e-5),d,abs(a)<1e-5);
 return exp(-.055*y)*max(I,0.);
}
// The same medium applies to all surfaces, but the enclosed hero cabin contains no outdoor snow fog.
fn fog(c:vec3f,p:vec3f)->vec3f{
 let v=p-g.cam.xyz;let d=max(length(v),.001);let rd=v/d;
 var integral=fogIntegral(g.cam.y,rd.y,d);
 let lo=vec3f(g.hero.x-g.hero.z,.30,g.hero.y-g.hero.w);
 let hi=vec3f(g.hero.x+g.hero.z,3.35,g.hero.y+g.hero.w);
 let safe=select(rd,vec3f(1e-5),abs(rd)<vec3f(1e-5));
 let a=(lo-g.cam.xyz)/safe;let b=(hi-g.cam.xyz)/safe;let near=min(a,b);let far=max(a,b);
 let enter=max(0.,max(near.x,max(near.y,near.z)));let leave=min(d,min(far.x,min(far.y,far.z)));
 if(leave>enter){integral-=fogIntegral(g.cam.y+rd.y*enter,rd.y,leave-enter);}
 let middle=g.cam.xyz+rd*d*.45;
 let bank=noise(middle*vec3f(.035,.10,.025)+vec3f(-g.cam.w*.045,0.,g.cam.w*.018));
 let gust=1.+g.params.y*(bank-.5)*.65;
 let optical=g.fog.w*max(integral,0.)*gust;
 let T=exp(-min(optical,30.));let tint=mix(g.fog.rgb,g.skyLow.rgb,sat(rd.y*.6));
 return c*T+tint*(1.-T);
}
`;

const VERTEX = /* wgsl */ `
struct VI{@location(0) p:vec3f,@location(1) n:vec4f,@location(2) a:vec4f,@location(3) b:vec4f,@location(4) c:vec4f,@location(5) d:vec4f};
struct VO{@builtin(position) cp:vec4f,@location(0) wp:vec3f,@location(1) n:vec3f,@location(2) op:vec3f,@location(3) @interpolate(flat) color:vec4f,@location(4) @interpolate(flat) material:vec4f};
fn rotate(v:vec3f,a:f32)->vec3f{let c=cos(a);let s=sin(a);return vec3f(c*v.x+s*v.z,v.y,-s*v.x+c*v.z);}
fn world(i:VI)->vec3f{
 var p=rotate(i.p*i.b.xyz,i.a.w)+i.a.xyz;
 if(i.d.z>.5){let sway=(sin(g.cam.w*.8+i.a.x*.1+i.a.z*.07)+.3*sin(g.cam.w*2.1+i.p.y*6.))*g.params.y*.13;p.x+=sway*pow(max(i.p.y,0.),1.8);}
 return p;
}
@vertex fn vs(i:VI)->VO{var o:VO;let p=world(i);o.cp=g.vp*vec4f(p,1.);o.wp=p;o.n=rotate(i.n.xyz/max(i.b.xyz,vec3f(.001)),i.a.w);o.op=i.p;o.color=i.c;o.material=i.d;return o;}
@vertex fn vsShadow(i:VI)->@builtin(position) vec4f{return g.shadow*vec4f(world(i),1.);}
`;

export const SOLID =
  GLOBAL +
  VERTEX +
  /* wgsl */ `
@group(0) @binding(1) var shadowMap:texture_depth_2d;
@group(0) @binding(2) var shadowSampler:sampler_comparison;
@group(0) @binding(3) var groundMap:texture_2d<f32>;
@group(0) @binding(4) var groundSampler:sampler;
fn shadow(p:vec3f,n:vec3f)->f32{
 let q=g.shadow*vec4f(p+n*.06,1.);let uv=vec2f(q.x*.5+.5,.5-q.y*.5);
 if(any(uv<vec2f(0.))||any(uv>vec2f(1.))){return 1.;}
 var a=0.;let e=1./2048.;
 for(var x=0;x<2;x++){for(var y=0;y<2;y++){a+=textureSampleCompareLevel(shadowMap,shadowSampler,uv+(vec2f(f32(x),f32(y))-.5)*e*2.,q.z-.0015);}}
 return a*.25;
}
@fragment fn fs(i:VO,@builtin(front_facing) front:bool)->@location(0) vec4f{
 var n=normalize(i.n)*select(-1.,1.,front);let V=normalize(g.cam.xyz-i.wp);let mat=i.material.x;
 var coverage=1.;
 if(mat>5.5&&mat<6.5){
   let needles=noise(i.op*vec3f(850.,1300.,850.));
   coverage=mix(smoothstep(.32,.64,needles),1.,smoothstep(16.,48.,distance(i.wp,g.cam.xyz)));
   if(coverage<.18){discard;}
 }
 let detail=noise(i.wp*2.7);let broad=noise(i.wp*.26);
 var albedo=i.color.rgb;var rough=.8;
 if((mat>0.5&&mat<1.5)||(mat>7.5&&mat<8.5)){
   let frost=noise(i.wp*11.);
   let ripple=sin(i.wp.x*1.65+i.wp.z*.70+noise(i.wp*.24)*5.);
   albedo*=.87+.16*detail+.055*ripple;
   let base=noise(i.wp*4.);
   let dx=noise(i.wp*4.+vec3f(.13,0,0))-base;let dz=noise(i.wp*4.+vec3f(0,0,.13))-base;
   n=normalize(n+vec3f(dx,0,dz)*.45);
   rough=.63;
   if(mat>7.5){
     let uv=i.wp.xz/220.+.5;let marks=textureSampleLevel(groundMap,groundSampler,uv,0.).rg;
     let e=1./1024.;let mx=textureSampleLevel(groundMap,groundSampler,uv+vec2f(e,0.),0.).g;
     let mz=textureSampleLevel(groundMap,groundSampler,uv+vec2f(0.,e),0.).g;
     albedo=mix(albedo,vec3f(.30,.40,.47)*(.85+.2*detail),marks.r*.68);
     albedo*=1.-marks.g*.24;n=normalize(n+vec3f(mx-marks.g,0.,mz-marks.g)*.7);
     rough=mix(.63,.89,marks.r);
   }
 }else if(mat>1.5&&mat<2.5){
   let along=select(i.wp.x,i.wp.z,abs(n.x)>.6);
   let grain=noise(vec3f(along*.65,i.wp.y*38.,noise(i.wp*.3)*1.8));
   let grainFine=noise(vec3f(along*1.5,i.wp.y*120.,.7));
   let seam=pow(sat(1.-abs(sin((i.wp.y+noise(i.wp*.4)*.009)*13.35))),10.);
   albedo*=.65+.44*grain+.16*grainFine;albedo*=1.-seam*.20;
   let worn=noise(i.wp*3.5);albedo=mix(albedo,albedo*vec3f(.63,.79,.90),smoothstep(.64,.85,worn)*.5);
   rough=.88;
 }else if(mat>2.5&&mat<3.5){albedo*=.65+.55*broad+.2*detail;}
 else if(mat>3.5&&mat<4.5){rough=.34;}
 else if(mat>5.5&&mat<6.5){albedo*=.65+.5*detail;rough=.95;}
 else if(mat>6.5){albedo*=.94+.12*detail;}
 let sunlit=shadow(i.wp,n);
 let ndl=sat(dot(n,g.sun.xyz));
 let skyAmbient=mix(g.skyLow.rgb,g.skyHigh.rgb,sat(n.y*.5+.5))*(.35+.65*sat(n.y*.5+.5));
 var c=albedo*(skyAmbient*.85+g.light.rgb*ndl*sunlit);
 let H=normalize(V+g.sun.xyz);let spec=pow(sat(dot(n,H)),mix(64.,8.,rough))*sunlit;
 c+=g.light.rgb*spec*.12;
 // Snow's broad forward scattering is an artistic approximation, not a full BSSRDF.
 if((mat>0.5&&mat<1.5)||(mat>7.5&&mat<8.5)){c+=albedo*g.light.rgb*pow(sat(dot(-V,g.sun.xyz)),4.)*.075;}
 for(var k=0u;k<32u;k++){
   let l=g.lights[k];if(l.w==0.){break;}
   let v=l.xyz-i.wp;let d2=dot(v,v);
   if(d2<49.){let dist=max(sqrt(d2),.01);let fall=pow(sat(1.-dist/7.),2.);
     c+=albedo*vec3f(1.,.35,.065)*(l.w*fall/(1.+d2*.3))*(.25+.75*sat(dot(n,v/dist)));}
 }
 var emission=i.color.rgb*i.color.a;
 if(mat>8.5&&mat<9.5){
   let uv=select(i.op.xy,i.op.zy,abs(n.x)>.6);
   let edge=min(.5-abs(uv.x),.5-abs(uv.y));
   let crystal=noise(i.wp*42.);let frost=(1.-smoothstep(.015,.12+crystal*.05,edge));
   let curtains=.60+.32*smoothstep(.10,.65,noise(vec3f(uv.x*13.,uv.y*2.,1.)));
   emission*=curtains*(1.-frost*.72);c+=vec3f(.12,.19,.24)*frost;
 }
 c+=emission*(.97+.03*sin(g.cam.w*1.7+i.wp.x));
 // Local interior fill is bounded to this cabin's footprint; it never changes simulation state.
 let inside=step(abs(i.wp.x-g.hero.x),g.hero.z)*step(abs(i.wp.z-g.hero.y),g.hero.w)*step(i.wp.y,3.25);
 c+=albedo*vec3f(.65,.24,.07)*inside*.55;
 return vec4f(fog(c,i.wp),coverage);
}
`;

export const SKY =
  GLOBAL +
  /* wgsl */ `
struct O{@builtin(position) p:vec4f,@location(0) uv:vec2f};
@vertex fn vs(@builtin(vertex_index) i:u32)->O{var o:O;let p=vec2f(f32(i32(i&1u)*4-1),f32(i32(i>>1u)*4-1));o.p=vec4f(p,0.,1.);o.uv=p;return o;}
@fragment fn fs(i:O)->@location(0) vec4f{let rd=normalize(g.forward.xyz+g.right.xyz*i.uv.x*g.right.w+g.up.xyz*i.uv.y*g.up.w);return vec4f(sky(rd),1.);}
`;

export const PARTICLES =
  GLOBAL +
  /* wgsl */ `
struct O{@builtin(position) p:vec4f,@location(0) uv:vec2f,@location(1) color:vec4f,@location(2) @interpolate(flat) kind:f32};
@vertex fn vs(@builtin(vertex_index) vi:u32,@builtin(instance_index) instance:u32,@location(0) seed:vec4f)->O{
 var o:O;let q=vec2f(f32(vi&1u),f32(vi>>1u))*2.-1.;let t=g.cam.w;let storm=g.params.y;
 let gust=.75+.25*sin(t*.65)+.12*sin(t*1.7+seed.x*7.);
 let wind=vec3f(mix(.6,6.5,storm)*gust,-(.7+seed.w*1.8),mix(.2,1.9,storm));
 let B=select(48.,110.,seed.z>.63);let drift=wind*t;
 var p=g.cam.xyz+(fract((seed.xyz*B+drift-g.cam.xyz)/B+.5)-.5)*B;
 p.x+=sin(t*.7+seed.y*60.)*(.12+storm*.32);p.z+=cos(t*.6+seed.x*50.)*.18;
 var size=(.008+.028*pow(seed.w,3.))*mix(1.,.75,g.params.z);
 var stretch=1.+storm*(1.+seed.x*2.);o.kind=0.;
 if(instance>=8500u&&instance<10000u){p.y=.08+seed.z*.55;size=.10+seed.w*.22;stretch=.12;o.kind=1.;}
 var axis=vec2f(dot(wind,g.right.xyz),dot(wind,g.up.xyz));axis/=max(length(axis),.001);
 var opacity=.30+storm*.45;
 if(instance>=10000u){
   let age=fract(t*.105+seed.x);let height=age*8.;
   p=g.chimney.xyz+vec3f(age*age*(3.+storm*7.),height,age*age*2.);
   p.x+=sin(age*9.+seed.y*6.)*age*.7;p.z+=cos(age*7.+seed.z*6.)*age*.6;
   size=.10+age*.9;stretch=1.;axis=vec2f(0.,1.);opacity=.035*pow(1.-age,1.8)*smoothstep(0.,.06,age);o.kind=2.;
 }
 let d=length(p-g.cam.xyz);let crossAxis=vec2f(-axis.y,axis.x);
 let offset=crossAxis*q.x*size+axis*q.y*size*stretch;
 let w=p+g.right.xyz*offset.x+g.up.xyz*offset.y;
 o.p=g.vp*vec4f(w,1.);o.uv=q;
 var fade=smoothstep(.4,1.7,d)*(1.-smoothstep(B*.34,B*.49,d))*smoothstep(-.15,.25,p.y);
 let indoor=step(abs(p.x-g.hero.x),g.hero.z)*step(abs(p.z-g.hero.y),g.hero.w)*step(p.y,6.);
 if(o.kind==1.){opacity*=storm*.3;fade*=.6+.4*sin(t*.9+seed.x*31.);}
 let alpha=fade*(1.-indoor)*opacity*exp(-d*g.fog.w);
 let warm=pow(sat(1.-distance(p,vec3f(g.hero.x,2.,g.hero.y+g.hero.w))/9.),2.);
 var color=mix(g.skyLow.rgb*1.6,vec3f(1.,.55,.2),warm*.8);
 if(o.kind==2.){color=mix(g.skyLow.rgb*.7,g.fog.rgb,.5);}
 o.color=vec4f(color,alpha);
 if(instance<10000u&&seed.w>mix(.13,1.,storm)){o.p=vec4f(0.,0.,2.,1.);}
 return o;
}
@fragment fn fs(i:O)->@location(0) vec4f{
 let radius=dot(i.uv,i.uv);let soft=exp(-radius*select(3.3,2.,i.kind>0.));
 let a=i.color.a*soft;return vec4f(i.color.rgb*a,a);
}
`;

const FULLSCREEN = /* wgsl */ `
struct O{@builtin(position) p:vec4f,@location(0) uv:vec2f};
@vertex fn vs(@builtin(vertex_index) i:u32)->O{var o:O;let p=vec2f(f32(i32(i&1u)*4-1),f32(i32(i>>1u)*4-1));o.p=vec4f(p,0.,1.);o.uv=vec2f(p.x*.5+.5,.5-p.y*.5);return o;}
`;
// Six-level bloom pyramid, with source-style first-downsample firefly suppression.
export const BLOOM =
  FULLSCREEN +
  /* wgsl */ `
@group(0) @binding(0) var source:texture_2d<f32>;
@group(0) @binding(1) var samp:sampler;
fn blur(uv:vec2f)->vec3f{let e=1./vec2f(textureDimensions(source));return (textureSample(source,samp,uv+e*vec2f(-.6,-.6)).rgb+textureSample(source,samp,uv+e*vec2f(.6,-.6)).rgb+textureSample(source,samp,uv+e*vec2f(-.6,.6)).rgb+textureSample(source,samp,uv+e*vec2f(.6,.6)).rgb)*.25;}
@fragment fn down(i:O)->@location(0) vec4f{return vec4f(blur(i.uv),1.);}
@fragment fn bright(i:O)->@location(0) vec4f{let c=blur(i.uv);let b=max(c.r,max(c.g,c.b));return vec4f(c*smoothstep(.65,2.,b),1.);}
`;
export const POST =
  GLOBAL +
  FULLSCREEN +
  /* wgsl */ `
@group(0) @binding(1) var scene:texture_2d<f32>;
@group(0) @binding(2) var bloom:texture_2d<f32>;
@group(0) @binding(3) var samp:sampler;
fn tone(x:vec3f)->vec3f{return clamp((x*(2.51*x+.03))/(x*(2.43*x+.59)+.14),vec3f(0.),vec3f(1.));}
@fragment fn fs(i:O)->@location(0) vec4f{
 var c=textureSample(scene,samp,i.uv).rgb+textureSample(bloom,samp,i.uv).rgb*.18;
 c*=g.params.w;let q=i.uv-.5;c*=1.-dot(q,q)*.42;
 c=tone(c);c=pow(c,vec3f(1./2.2));
 let grain=fract(52.9829189*fract(dot(i.p.xy,vec2f(.06711056,.00583715))))-.5;
 return vec4f(c+grain/255.,1.);
}
`;
