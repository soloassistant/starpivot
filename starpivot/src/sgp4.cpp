// SGP4 / SDP4. Algorithm of Hoots & Roehrich, Spacetrack Report #3 (1980),
// with the corrections published in Vallado et al., "Revisiting Spacetrack
// Report #3", AIAA 2006-6753 Rev 1, whose Appendix D supplies the verification
// vectors this module is checked against in tests/test_sgp4.cpp.
//
// This is an independent implementation written against that published
// specification; it uses only the C++17 standard library.

#include "starpivot/sgp4.hpp"

#include <cmath>
#include <cstdlib>
#include <vector>

#include "starpivot/time.hpp"

namespace starpivot {
namespace {

constexpr double kPi = 3.14159265358979323846;
constexpr double kTwoPi = 6.28318530717958647692;

// Operation mode: 'i' (improved) rather than 'a' (AFSPC). The two differ only
// in whether the node angle is forced into [0, 2pi) after the Lyddane
// modification; the published vectors are reproduced with 'i'.
constexpr char kOpsMode = 'i';

/// Parse TLE's exponent-less notation: "28098-4" -> 2.8098e-4, "-.00000158"
/// -> -1.58e-6, "00000-0" -> 0.0.
double tle_number(const std::string& s, bool* ok) {
    if (ok) *ok = true;
    if (s.empty()) {
        if (ok) *ok = false;
        return 0.0;
    }
    std::string t = s;
    // An exponent is written sign+digits with no 'e', e.g. the "-4" in "66816-4".
    // Scan from the back over the exponent digits, then check for a sign directly
    // before them. (Stopping the scan at the sign itself -- the previous bug --
    // meant the exponent was never detected, inflating bstar/ndot/nddot 1000x.)
    std::size_t d = t.size();
    while (d > 0 && std::isdigit(static_cast<unsigned char>(t[d - 1]))) --d;
    bool have_exp = false;
    int exp10 = 0;
    if (d > 0 && d < t.size() && (t[d - 1] == '-' || t[d - 1] == '+') &&
        std::isdigit(static_cast<unsigned char>(t[d]))) {
        const char sign = t[d - 1];
        const std::string digits = t.substr(d);
        if (!digits.empty()) {
            have_exp = true;
            exp10 = std::atoi(digits.c_str());
            if (sign == '-') exp10 = -exp10;
            t = t.substr(0, d - 1);
        }
    }
    // Strip a leading '+'.
    if (!t.empty() && t[0] == '+') t = t.substr(1);
    // In TLE notation the mantissa has an IMPLIED leading decimal point when
    // none is printed: "66816-4" is 0.66816e-4, not 66816e-4. Getting this
    // wrong inflates bstar by 1e5, which at first looks harmless because the
    // drag term is proportional to elapsed time and therefore vanishes at
    // t = 0 -- the epoch test vectors still pass while every later epoch is
    // garbage. That is exactly why the acceptance suite checks t > 0.
    if (t.find('.') == std::string::npos && !t.empty()) t = "0." + t;
    double mant = 0.0;
    try {
        mant = std::stod(t);
    } catch (...) {
        if (ok) *ok = false;
        return 0.0;
    }
    if (have_exp) mant *= std::pow(10.0, exp10);
    return mant;
}

std::vector<std::string> split_ws(const std::string& s) {
    std::vector<std::string> out;
    std::string cur;
    for (char c : s) {
        if (std::isspace(static_cast<unsigned char>(c))) {
            if (!cur.empty()) { out.push_back(cur); cur.clear(); }
        } else {
            cur += c;
        }
    }
    if (!cur.empty()) out.push_back(cur);
    return out;
}

/// Epoch field looks like YYDDD.DDDDDDDD: five integer digits, eight decimals.
bool looks_like_epoch(const std::string& s) {
    if (s.size() < 14) return false;
    const std::size_t dot = s.find('.');
    if (dot != 5) return false;
    for (std::size_t i = 0; i < s.size(); ++i) {
        if (i == dot) continue;
        if (!std::isdigit(static_cast<unsigned char>(s[i]))) return false;
    }
    return (s.size() - dot - 1) == 8;
}

// ---------------------------------------------------------------------------
// Deep-space common quantities (lunar/solar long-period terms)
// ---------------------------------------------------------------------------

struct DsComOut {
    double snodm = 0, cnodm = 0, sinim = 0, cosim = 0, sinomm = 0, cosomm = 0;
    double day = 0, e3 = 0, ee2 = 0, em = 0, emsq = 0, gam = 0;
    double peo = 0, pgho = 0, pho = 0, pinco = 0, plo = 0, rtemsq = 0;
    double se2 = 0, se3 = 0, sgh2 = 0, sgh3 = 0, sgh4 = 0, sh2 = 0, sh3 = 0;
    double si2 = 0, si3 = 0, sl2 = 0, sl3 = 0, sl4 = 0;
    double s1 = 0, s2 = 0, s3 = 0, s4 = 0, s5 = 0, s6 = 0, s7 = 0;
    double ss1 = 0, ss2 = 0, ss3 = 0, ss4 = 0, ss5 = 0, ss6 = 0, ss7 = 0;
    double sz1 = 0, sz2 = 0, sz3 = 0, sz11 = 0, sz12 = 0, sz13 = 0;
    double sz21 = 0, sz22 = 0, sz23 = 0, sz31 = 0, sz32 = 0, sz33 = 0;
    double xgh2 = 0, xgh3 = 0, xgh4 = 0, xh2 = 0, xh3 = 0;
    double xi2 = 0, xi3 = 0, xl2 = 0, xl3 = 0, xl4 = 0;
    double nm = 0, z1 = 0, z2 = 0, z3 = 0, z11 = 0, z12 = 0, z13 = 0;
    double z21 = 0, z22 = 0, z23 = 0, z31 = 0, z32 = 0, z33 = 0;
    double zmol = 0, zmos = 0;
};

DsComOut dscom(double epoch, double ep, double argpp, double tc, double inclp,
               double nodep, double np) {
    const double zes = 0.01675;
    const double zel = 0.05490;
    const double c1ss = 2.9864797e-6;
    const double c1l = 4.7968065e-7;
    const double zsinis = 0.39785416;
    const double zcosis = 0.91744867;
    const double zcosgs = 0.1945905;
    const double zsings = -0.98088458;

    DsComOut o{};
    o.nm = np;
    o.em = ep;
    o.snodm = std::sin(nodep);
    o.cnodm = std::cos(nodep);
    o.sinomm = std::sin(argpp);
    o.cosomm = std::cos(argpp);
    o.sinim = std::sin(inclp);
    o.cosim = std::cos(inclp);
    o.emsq = o.em * o.em;
    const double betasq = 1.0 - o.emsq;
    o.rtemsq = std::sqrt(betasq);

    o.peo = 0.0;
    o.pinco = 0.0;
    o.plo = 0.0;
    o.pgho = 0.0;
    o.pho = 0.0;
    o.day = epoch + 18261.5 + tc / 1440.0;
    const double xnodce = std::fmod(4.5236020 - 9.2422029e-4 * o.day, kTwoPi);
    const double stem = std::sin(xnodce);
    const double ctem = std::cos(xnodce);
    const double zcosil = 0.91375164 - 0.03568096 * ctem;
    const double zsinil = std::sqrt(1.0 - zcosil * zcosil);
    const double zsinhl = 0.089683511 * stem / zsinil;
    const double zcoshl = std::sqrt(1.0 - zsinhl * zsinhl);
    const double gam = 5.8351514 + 0.0019443680 * o.day;
    double zx = 0.39785416 * stem / zsinil;
    const double zy = zcoshl * ctem + 0.91744867 * zsinhl * stem;
    zx = std::atan2(zx, zy);
    zx = gam + zx - xnodce;
    const double zcosgl = std::cos(zx);
    const double zsingl = std::sin(zx);
    o.gam = gam;

    double zcosg = zcosgs, zsing = zsings, zcosi = zcosis, zsini = zsinis;
    double zcosh = o.cnodm, zsinh = o.snodm, cc = c1ss, xnoi = 1.0 / o.nm;

    for (int lsflg = 1; lsflg <= 2; ++lsflg) {
        const double a1 = zcosg * zcosh + zsing * zcosi * zsinh;
        const double a3 = -zsing * zcosh + zcosg * zcosi * zsinh;
        const double a7 = -zcosg * zsinh + zsing * zcosi * zcosh;
        const double a8 = zsing * zsini;
        const double a9 = zsing * zsinh + zcosg * zcosi * zcosh;
        const double a10 = zcosg * zsini;
        const double a2 = o.cosim * a7 + o.sinim * a8;
        const double a4 = o.cosim * a9 + o.sinim * a10;
        const double a5 = -o.sinim * a7 + o.cosim * a8;
        const double a6 = -o.sinim * a9 + o.cosim * a10;

        const double x1 = a1 * o.cosomm + a2 * o.sinomm;
        const double x2 = a3 * o.cosomm + a4 * o.sinomm;
        const double x3 = -a1 * o.sinomm + a2 * o.cosomm;
        const double x4 = -a3 * o.sinomm + a4 * o.cosomm;
        const double x5 = a5 * o.sinomm;
        const double x6 = a6 * o.sinomm;
        const double x7 = a5 * o.cosomm;
        const double x8 = a6 * o.cosomm;

        o.z31 = 12.0 * x1 * x1 - 3.0 * x3 * x3;
        o.z32 = 24.0 * x1 * x2 - 6.0 * x3 * x4;
        o.z33 = 12.0 * x2 * x2 - 3.0 * x4 * x4;
        o.z1 = 3.0 * (a1 * a1 + a2 * a2) + o.z31 * o.emsq;
        o.z2 = 6.0 * (a1 * a3 + a2 * a4) + o.z32 * o.emsq;
        o.z3 = 3.0 * (a3 * a3 + a4 * a4) + o.z33 * o.emsq;
        o.z11 = -6.0 * a1 * a5 + o.emsq * (-24.0 * x1 * x7 - 6.0 * x3 * x5);
        o.z12 = -6.0 * (a1 * a6 + a3 * a5) +
                o.emsq * (-24.0 * (x2 * x7 + x1 * x8) - 6.0 * (x3 * x6 + x4 * x5));
        o.z13 = -6.0 * a3 * a6 + o.emsq * (-24.0 * x2 * x8 - 6.0 * x4 * x6);
        o.z21 = 6.0 * a2 * a5 + o.emsq * (24.0 * x1 * x5 - 6.0 * x3 * x7);
        o.z22 = 6.0 * (a4 * a5 + a2 * a6) +
                o.emsq * (24.0 * (x2 * x5 + x1 * x6) - 6.0 * (x4 * x7 + x3 * x8));
        o.z23 = 6.0 * a4 * a6 + o.emsq * (24.0 * x2 * x6 - 6.0 * x4 * x8);
        o.z1 = o.z1 + o.z1 + betasq * o.z31;
        o.z2 = o.z2 + o.z2 + betasq * o.z32;
        o.z3 = o.z3 + o.z3 + betasq * o.z33;
        o.s3 = cc * xnoi;
        o.s2 = -0.5 * o.s3 / o.rtemsq;
        o.s4 = o.s3 * o.rtemsq;
        o.s1 = -15.0 * o.em * o.s4;
        o.s5 = x1 * x3 + x2 * x4;
        o.s6 = x2 * x3 + x1 * x4;
        o.s7 = x2 * x4 - x1 * x3;

        if (lsflg == 1) {
            o.ss1 = o.s1; o.ss2 = o.s2; o.ss3 = o.s3; o.ss4 = o.s4;
            o.ss5 = o.s5; o.ss6 = o.s6; o.ss7 = o.s7;
            o.sz1 = o.z1; o.sz2 = o.z2; o.sz3 = o.z3;
            o.sz11 = o.z11; o.sz12 = o.z12; o.sz13 = o.z13;
            o.sz21 = o.z21; o.sz22 = o.z22; o.sz23 = o.z23;
            o.sz31 = o.z31; o.sz32 = o.z32; o.sz33 = o.z33;
            zcosg = zcosgl; zsing = zsingl; zcosi = zcosil; zsini = zsinil;
            zcosh = zcoshl * o.cnodm + zsinhl * o.snodm;
            zsinh = o.snodm * zcoshl - o.cnodm * zsinhl;
            cc = c1l;
        }
    }

    o.zmol = std::fmod(4.7199672 + 0.22997150 * o.day - gam, kTwoPi);
    o.zmos = std::fmod(6.2565837 + 0.017201977 * o.day, kTwoPi);

    o.se2 = 2.0 * o.ss1 * o.ss6;
    o.se3 = 2.0 * o.ss1 * o.ss7;
    o.si2 = 2.0 * o.ss2 * o.sz12;
    o.si3 = 2.0 * o.ss2 * (o.sz13 - o.sz11);
    o.sl2 = -2.0 * o.ss3 * o.sz2;
    o.sl3 = -2.0 * o.ss3 * (o.sz3 - o.sz1);
    o.sl4 = -2.0 * o.ss3 * (-21.0 - 9.0 * o.emsq) * zes;
    o.sgh2 = 2.0 * o.ss4 * o.sz32;
    o.sgh3 = 2.0 * o.ss4 * (o.sz33 - o.sz31);
    o.sgh4 = -18.0 * o.ss4 * zes;
    o.sh2 = -2.0 * o.ss2 * o.sz22;
    o.sh3 = -2.0 * o.ss2 * (o.sz23 - o.sz21);

    o.ee2 = 2.0 * o.s1 * o.s6;
    o.e3 = 2.0 * o.s1 * o.s7;
    o.xi2 = 2.0 * o.s2 * o.z12;
    o.xi3 = 2.0 * o.s2 * (o.z13 - o.z11);
    o.xl2 = -2.0 * o.s3 * o.z2;
    o.xl3 = -2.0 * o.s3 * (o.z3 - o.z1);
    o.xl4 = -2.0 * o.s3 * (-21.0 - 9.0 * o.emsq) * zel;
    o.xgh2 = 2.0 * o.s4 * o.z32;
    o.xgh3 = 2.0 * o.s4 * (o.z33 - o.z31);
    o.xgh4 = -18.0 * o.s4 * zel;
    o.xh2 = -2.0 * o.s2 * o.z22;
    o.xh3 = -2.0 * o.s2 * (o.z23 - o.z21);
    return o;
}

// ---------------------------------------------------------------------------
// Long-period lunar-solar periodics
// ---------------------------------------------------------------------------

void dpper(const Sgp4& s, double t, bool init, double& ep, double& inclp,
           double& nodep, double& argpp, double& mp) {
    const double zns = 1.19459e-5;
    const double zes = 0.01675;
    const double znl = 1.5835218e-4;
    const double zel = 0.05490;

    double zm = s.zmos + zns * t;
    if (init) zm = s.zmos;
    double zf = zm + 2.0 * zes * std::sin(zm);
    double sinzf = std::sin(zf);
    double f2 = 0.5 * sinzf * sinzf - 0.25;
    double f3 = -0.5 * sinzf * std::cos(zf);
    const double ses = s.se2 * f2 + s.se3 * f3;
    const double sis = s.si2 * f2 + s.si3 * f3;
    const double sls = s.sl2 * f2 + s.sl3 * f3 + s.sl4 * sinzf;
    const double sghs = s.sgh2 * f2 + s.sgh3 * f3 + s.sgh4 * sinzf;
    const double shs = s.sh2 * f2 + s.sh3 * f3;

    zm = s.zmol + znl * t;
    if (init) zm = s.zmol;
    zf = zm + 2.0 * zel * std::sin(zm);
    sinzf = std::sin(zf);
    f2 = 0.5 * sinzf * sinzf - 0.25;
    f3 = -0.5 * sinzf * std::cos(zf);
    const double sel = s.ee2 * f2 + s.e3 * f3;
    const double sil = s.xi2 * f2 + s.xi3 * f3;
    const double sll = s.xl2 * f2 + s.xl3 * f3 + s.xl4 * sinzf;
    const double sghl = s.xgh2 * f2 + s.xgh3 * f3 + s.xgh4 * sinzf;
    const double shll = s.xh2 * f2 + s.xh3 * f3;

    double pe = ses + sel;
    double pinc = sis + sil;
    double pl = sls + sll;
    double pgh = sghs + sghl;
    double ph = shs + shll;

    if (!init) {
        // The epoch offsets peo..pho are zero in this formulation, so the
        // subtraction below is a no-op; it is kept because it is part of the
        // published algorithm and documents where a non-zero epoch offset
        // would enter.
        pe = pe - s.peo;
        pinc = pinc - s.pinco;
        pl = pl - s.plo;
        pgh = pgh - s.pgho;
        ph = ph - s.pho;

        inclp = inclp + pinc;
        ep = ep + pe;
        const double sinip = std::sin(inclp);
        const double cosip = std::cos(inclp);

        if (inclp >= 0.2) {  // 0.2 rad = 11.46 deg
            ph = ph / sinip;
            pgh = pgh - cosip * ph;
            argpp = argpp + pgh;
            nodep = nodep + ph;
            mp = mp + pl;
        } else {
            // Lyddane modification for near-equatorial orbits.
            const double sinop = std::sin(nodep);
            const double cosop = std::cos(nodep);
            double alfdp = sinip * sinop;
            double betdp = sinip * cosop;
            const double dalf = ph * cosop + pinc * cosip * sinop;
            const double dbet = -ph * sinop + pinc * cosip * cosop;
            alfdp = alfdp + dalf;
            betdp = betdp + dbet;
            nodep = std::fmod(nodep, kTwoPi);
            if ((nodep < 0.0) && (kOpsMode == 'a')) nodep = nodep + kTwoPi;
            double xls = mp + argpp + cosip * nodep;
            const double dls = pl + pgh - pinc * nodep * sinip;
            xls = xls + dls;
            const double xnoh = nodep;
            nodep = std::atan2(alfdp, betdp);
            if ((nodep < 0.0) && (kOpsMode == 'a')) nodep = nodep + kTwoPi;
            if (std::fabs(xnoh - nodep) > kPi) {
                if (nodep < xnoh) nodep = nodep + kTwoPi;
                else nodep = nodep - kTwoPi;
            }
            mp = mp + pl;
            argpp = xls - mp - cosip * nodep;
        }
    }
}

// ---------------------------------------------------------------------------
// Deep-space initialisation: resonance coefficients and integrator state
// ---------------------------------------------------------------------------

void dsinit(Sgp4& s, const DsComOut& c, double tc, double xpidot, double& em,
            double& argpm, double& inclm, double& mm, double& nm, double& nodem) {
    const double q22 = 1.7891679e-6;
    const double q31 = 2.1460748e-6;
    const double q33 = 2.2123015e-7;
    const double root22 = 1.7891679e-6;
    const double root44 = 7.3636953e-9;
    const double root54 = 2.1765803e-9;
    const double rptim = 4.37526908801129966e-3;  // 7.29211514668855e-5 rad/s
    const double root32 = 3.7393792e-7;
    const double root52 = 1.1428639e-7;
    const double x2o3 = 2.0 / 3.0;
    const double znl = 1.5835218e-4;
    const double zns = 1.19459e-5;

    s.irez = 0;
    if ((nm < 0.0052359877) && (nm > 0.0034906585)) s.irez = 1;
    if ((nm >= 8.26e-3) && (nm <= 9.24e-3) && (em >= 0.5)) s.irez = 2;

    double ses = c.ss1 * zns * c.ss5;
    double sis = c.ss2 * zns * (c.sz11 + c.sz13);
    double sls = -zns * c.ss3 * (c.sz1 + c.sz3 - 14.0 - 6.0 * c.emsq);
    double sghs = c.ss4 * zns * (c.sz31 + c.sz33 - 6.0);
    double shs = -zns * c.ss2 * (c.sz21 + c.sz23);
    if ((inclm < 5.2359877e-2) || (inclm > kPi - 5.2359877e-2)) shs = 0.0;
    if (c.sinim != 0.0) shs = shs / c.sinim;
    const double sgs = sghs - c.cosim * shs;

    s.dedt = ses + c.s1 * znl * c.s5;
    s.didt = sis + c.s2 * znl * (c.z11 + c.z13);
    s.dmdt = sls - znl * c.s3 * (c.z1 + c.z3 - 14.0 - 6.0 * c.emsq);
    const double sghl = c.s4 * znl * (c.z31 + c.z33 - 6.0);
    double shll = -znl * c.s2 * (c.z21 + c.z23);
    if ((inclm < 5.2359877e-2) || (inclm > kPi - 5.2359877e-2)) shll = 0.0;
    s.domdt = sgs + sghl;
    s.dnodt = shs;
    if (c.sinim != 0.0) {
        s.domdt = s.domdt - c.cosim / c.sinim * shll;
        s.dnodt = s.dnodt + shll / c.sinim;
    }

    const double theta = std::fmod(s.gsto + tc * rptim, kTwoPi);
    em = em + s.dedt * s.t;
    inclm = inclm + s.didt * s.t;
    argpm = argpm + s.domdt * s.t;
    nodem = nodem + s.dnodt * s.t;
    mm = mm + s.dmdt * s.t;
    (void)theta;

    if (s.irez != 0) {
        const double aonv = std::pow(nm / s.xke, x2o3);

        if (s.irez == 2) {
            const double cosisq = c.cosim * c.cosim;
            const double emo = em;
            em = s.ecco;
            const double emsqo = c.emsq;
            double emsq = s.ecco * s.ecco;
            const double eoc = em * emsq;
            const double g201 = -0.306 - (em - 0.64) * 0.440;

            double g211, g310, g322, g410, g422, g520;
            if (em <= 0.65) {
                g211 = 3.616 - 13.2470 * em + 16.2900 * emsq;
                g310 = -19.302 + 117.3900 * em - 228.4190 * emsq + 156.5910 * eoc;
                g322 = -18.9068 + 109.7927 * em - 214.6334 * emsq + 146.5816 * eoc;
                g410 = -41.122 + 242.6940 * em - 471.0940 * emsq + 313.9530 * eoc;
                g422 = -146.407 + 841.8800 * em - 1629.014 * emsq + 1083.4350 * eoc;
                g520 = -532.114 + 3017.977 * em - 5740.032 * emsq + 3708.2760 * eoc;
            } else {
                g211 = -72.099 + 331.819 * em - 508.738 * emsq + 266.724 * eoc;
                g310 = -346.844 + 1582.851 * em - 2415.925 * emsq + 1246.113 * eoc;
                g322 = -342.585 + 1554.908 * em - 2366.899 * emsq + 1215.972 * eoc;
                g410 = -1052.797 + 4758.686 * em - 7193.992 * emsq + 3651.957 * eoc;
                g422 = -3581.690 + 16178.110 * em - 24462.770 * emsq + 12422.520 * eoc;
                if (em > 0.715)
                    g520 = -5149.66 + 29936.92 * em - 54087.36 * emsq + 31324.56 * eoc;
                else
                    g520 = 1464.74 - 4664.75 * em + 3763.64 * emsq;
            }
            double g533, g521, g532;
            if (em < 0.7) {
                g533 = -919.22770 + 4988.6100 * em - 9064.7700 * emsq + 5542.21 * eoc;
                g521 = -822.71072 + 4568.6173 * em - 8491.4146 * emsq + 5337.524 * eoc;
                g532 = -853.66600 + 4690.2500 * em - 8624.7700 * emsq + 5341.4 * eoc;
            } else {
                g533 = -37995.780 + 161616.52 * em - 229838.20 * emsq + 109377.94 * eoc;
                g521 = -51752.104 + 218913.95 * em - 309468.16 * emsq + 146349.42 * eoc;
                g532 = -40023.880 + 170470.89 * em - 242699.48 * emsq + 115605.82 * eoc;
            }

            const double sini2 = c.sinim * c.sinim;
            const double f220 = 0.75 * (1.0 + 2.0 * c.cosim + cosisq);
            const double f221 = 1.5 * sini2;
            const double f321 = 1.875 * c.sinim * (1.0 - 2.0 * c.cosim - 3.0 * cosisq);
            const double f322 = -1.875 * c.sinim * (1.0 + 2.0 * c.cosim - 3.0 * cosisq);
            const double f441 = 35.0 * sini2 * f220;
            const double f442 = 39.3750 * sini2 * sini2;
            const double f522 = 9.84375 * c.sinim *
                (sini2 * (1.0 - 2.0 * c.cosim - 5.0 * cosisq) +
                 0.33333333 * (-2.0 + 4.0 * c.cosim + 6.0 * cosisq));
            const double f523 = c.sinim *
                (4.92187512 * sini2 * (-2.0 - 4.0 * c.cosim + 10.0 * cosisq) +
                 6.56250012 * (1.0 + 2.0 * c.cosim - 3.0 * cosisq));
            const double f542 = 29.53125 * c.sinim *
                (2.0 - 8.0 * c.cosim + cosisq * (-12.0 + 8.0 * c.cosim + 10.0 * cosisq));
            const double f543 = 29.53125 * c.sinim *
                (-2.0 - 8.0 * c.cosim + cosisq * (12.0 + 8.0 * c.cosim - 10.0 * cosisq));

            const double xno2 = nm * nm;
            const double ainv2 = aonv * aonv;
            double temp1 = 3.0 * xno2 * ainv2;
            double temp = temp1 * root22;
            s.d2201 = temp * f220 * g201;
            s.d2211 = temp * f221 * g211;
            temp1 = temp1 * aonv;
            temp = temp1 * root32;
            s.d3210 = temp * f321 * g310;
            s.d3222 = temp * f322 * g322;
            temp1 = temp1 * aonv;
            temp = 2.0 * temp1 * root44;
            s.d4410 = temp * f441 * g410;
            s.d4422 = temp * f442 * g422;
            temp1 = temp1 * aonv;
            temp = temp1 * root52;
            s.d5220 = temp * f522 * g520;
            s.d5232 = temp * f523 * g532;
            temp = 2.0 * temp1 * root54;
            s.d5421 = temp * f542 * g521;
            s.d5433 = temp * f543 * g533;
            s.xlamo = std::fmod(s.mo + s.nodeo + s.nodeo - theta - theta, kTwoPi);
            s.xfact = s.mdot + s.dmdt + 2.0 * (s.nodedot + s.dnodt - rptim) - s.no_unkozai;
            em = emo;
            (void)emsqo;
            (void)emsq;
        }

        if (s.irez == 1) {
            const double g200 = 1.0 + c.emsq * (-2.5 + 0.8125 * c.emsq);
            const double g310 = 1.0 + 2.0 * c.emsq;
            const double g300 = 1.0 + c.emsq * (-6.0 + 6.60937 * c.emsq);
            const double f220 = 0.75 * (1.0 + c.cosim) * (1.0 + c.cosim);
            const double f311 = 0.9375 * c.sinim * c.sinim * (1.0 + 3.0 * c.cosim) -
                                0.75 * (1.0 + c.cosim);
            double f330 = 1.0 + c.cosim;
            f330 = 1.875 * f330 * f330 * f330;
            s.del1 = 3.0 * nm * nm * aonv * aonv;
            s.del2 = 2.0 * s.del1 * f220 * g200 * q22;
            s.del3 = 3.0 * s.del1 * f330 * g300 * q33 * aonv;
            s.del1 = s.del1 * f311 * g310 * q31 * aonv;
            s.xlamo = std::fmod(s.mo + s.nodeo + s.argpo - theta, kTwoPi);
            s.xfact = s.mdot + xpidot - rptim + s.dmdt + s.domdt + s.dnodt - s.no_unkozai;
        }

        s.xli = s.xlamo;
        s.xni = s.no_unkozai;
        s.atime = 0.0;
        nm = s.no_unkozai + s.dndt;
    }
}

// ---------------------------------------------------------------------------
// Deep-space propagation: secular drift plus the resonance integrator
// ---------------------------------------------------------------------------

void dspace(Sgp4& s, double tc, double& em, double& argpm, double& inclm,
            double& mm, double& nodem, double& dndt, double& nm) {
    const double fasx2 = 0.13130908;
    const double fasx4 = 2.8843198;
    const double fasx6 = 0.37448087;
    const double g22 = 5.7686396;
    const double g32 = 0.95240898;
    const double g44 = 1.8014998;
    const double g52 = 1.0508330;
    const double g54 = 4.4108898;
    const double rptim = 4.37526908801129966e-3;
    const double stepp = 720.0;
    const double stepn = -720.0;
    const double step2 = 259200.0;

    dndt = 0.0;
    const double theta = std::fmod(s.gsto + tc * rptim, kTwoPi);
    em = em + s.dedt * s.t;
    inclm = inclm + s.didt * s.t;
    argpm = argpm + s.domdt * s.t;
    nodem = nodem + s.dnodt * s.t;
    mm = mm + s.dmdt * s.t;

    double ft = 0.0;
    if (s.irez != 0) {
        if ((s.atime == 0.0) || (s.t * s.atime <= 0.0) || (std::fabs(s.t) < std::fabs(s.atime))) {
            s.atime = 0.0;
            s.xni = s.no_unkozai;
            s.xli = s.xlamo;
        }
        const double delt = (s.t > 0.0) ? stepp : stepn;

        bool iretn = true;
        double xndt = 0.0, xldot = 0.0, xnddt = 0.0;
        while (iretn) {
            if (s.irez != 2) {
                xndt = s.del1 * std::sin(s.xli - fasx2) +
                       s.del2 * std::sin(2.0 * (s.xli - fasx4)) +
                       s.del3 * std::sin(3.0 * (s.xli - fasx6));
                xldot = s.xni + s.xfact;
                xnddt = s.del1 * std::cos(s.xli - fasx2) +
                        2.0 * s.del2 * std::cos(2.0 * (s.xli - fasx4)) +
                        3.0 * s.del3 * std::cos(3.0 * (s.xli - fasx6));
                xnddt = xnddt * xldot;
            } else {
                const double xomi = s.argpo + s.argpdot * s.atime;
                const double x2omi = xomi + xomi;
                const double x2li = s.xli + s.xli;
                xndt = s.d2201 * std::sin(x2omi + s.xli - g22) +
                       s.d2211 * std::sin(s.xli - g22) +
                       s.d3210 * std::sin(xomi + s.xli - g32) +
                       s.d3222 * std::sin(-xomi + s.xli - g32) +
                       s.d4410 * std::sin(x2omi + x2li - g44) +
                       s.d4422 * std::sin(x2li - g44) +
                       s.d5220 * std::sin(xomi + s.xli - g52) +
                       s.d5232 * std::sin(-xomi + s.xli - g52) +
                       s.d5421 * std::sin(xomi + x2li - g54) +
                       s.d5433 * std::sin(-xomi + x2li - g54);
                xldot = s.xni + s.xfact;
                xnddt = s.d2201 * std::cos(x2omi + s.xli - g22) +
                        s.d2211 * std::cos(s.xli - g22) +
                        s.d3210 * std::cos(xomi + s.xli - g32) +
                        s.d3222 * std::cos(-xomi + s.xli - g32) +
                        s.d5220 * std::cos(xomi + s.xli - g52) +
                        s.d5232 * std::cos(-xomi + s.xli - g52) +
                        2.0 * (s.d4410 * std::cos(x2omi + x2li - g44) +
                               s.d4422 * std::cos(x2li - g44) +
                               s.d5421 * std::cos(xomi + x2li - g54) +
                               s.d5433 * std::cos(-xomi + x2li - g54));
                xnddt = xnddt * xldot;
            }

            if (std::fabs(s.t - s.atime) >= stepp) {
                iretn = true;
            } else {
                ft = s.t - s.atime;
                iretn = false;
            }
            if (iretn) {
                s.xli = s.xli + xldot * delt + xndt * step2;
                s.xni = s.xni + xndt * delt + xnddt * step2;
                s.atime = s.atime + delt;
            }
        }

        nm = s.xni + xndt * ft + xnddt * ft * ft * 0.5;
        const double xl = s.xli + xldot * ft + xndt * ft * ft * 0.5;
        if (s.irez != 1) {
            mm = xl - 2.0 * nodem + 2.0 * theta;
            dndt = nm - s.no_unkozai;
        } else {
            mm = xl - nodem - argpm + theta;
            dndt = nm - s.no_unkozai;
        }
        nm = s.no_unkozai + dndt;
    }
}

}  // namespace

// ---------------------------------------------------------------------------
// TLE parsing
// ---------------------------------------------------------------------------

bool parse_tle(const std::string& line1, const std::string& line2, Tle& out,
               std::string* error) {
    auto fail = [&](const std::string& m) {
        if (error) *error = m;
        return false;
    };

    const std::vector<std::string> t1 = split_ws(line1);
    const std::vector<std::string> t2 = split_ws(line2);

    if (t1.size() < 7) return fail("line 1 has too few fields");
    if (t2.size() < 8) return fail("line 2 has too few fields");
    if (t1[0] != "1" || t2[0] != "2") return fail("line numbers must be 1 and 2");

    // Satellite number carries a classification letter ("88888U").
    {
        const std::string& s = t1[1];
        std::string digits;
        for (char c : s) {
            if (std::isdigit(static_cast<unsigned char>(c))) digits += c;
            else break;
        }
        if (digits.empty()) return fail("cannot read satellite number");
        out.satnum = std::atoi(digits.c_str());
    }

    // Locate the epoch field. It is uniquely YYDDD.DDDDDDDD; the international
    // designator may be absent, so a fixed index would break.
    std::size_t ei = 0;
    bool found = false;
    for (std::size_t i = 2; i < t1.size(); ++i) {
        if (looks_like_epoch(t1[i])) { ei = i; found = true; break; }
    }
    if (!found) return fail("cannot locate epoch field in line 1");
    if (ei + 3 >= t1.size()) return fail("line 1 missing ndot/nddot/bstar");

    // International designator sits between the satellite number (t1[1]) and
    // the epoch (t1[ei]). It is blank for some legacy objects (e.g. 88888),
    // in which case split_ws leaves no token here and ei == 2.
    if (ei > 2) out.intl_designator = t1[ei - 1];

    out.epoch_day = std::stod(t1[ei]);
    out.epoch_year = static_cast<int>(out.epoch_day / 1000.0);
    const double doy = out.epoch_day - out.epoch_year * 1000.0;
    const int year = (out.epoch_year < 57) ? out.epoch_year + 2000 : out.epoch_year + 1900;

    // Jan 1 of the epoch year, then (day-of-year - 1) days.
    out.epoch_jd = julian_date(year, 1, 1, 0.0) + (doy - 1.0);
    out.jdsatepoch = out.epoch_jd - 2433281.5;

    bool ok = true;
    out.ndot = tle_number(t1[ei + 1], &ok) * kTwoPi / (1440.0 * 1440.0);
    if (!ok) return fail("cannot parse ndot");
    out.nddot = tle_number(t1[ei + 2], nullptr) * kTwoPi / (1440.0 * 1440.0 * 1440.0);
    out.bstar = tle_number(t1[ei + 3], &ok);
    if (!ok) return fail("cannot parse bstar");

    const double deg = kPi / 180.0;
    out.inclo = std::stod(t2[2]) * deg;
    out.nodeo = std::stod(t2[3]) * deg;
    // Eccentricity is printed with an implied leading decimal point.
    out.ecco = std::stod("0." + t2[4]);
    out.argpo = std::stod(t2[5]) * deg;
    out.mo = std::stod(t2[6]) * deg;
    // Mean motion lives in TLE columns 53-63: a fixed 11-character field. The
    // element-set number (columns 64-68) and checksum (69) are NOT separated
    // by whitespace in every TLE, so a naive stod() of the trailing token would
    // swallow them. The reference SGP4 reads this field with "%11lf"; we do the
    // same by taking at most the first 11 characters, matching Spacetrack #3.
    out.no_kozai = std::stod(t2[7].substr(0, 11)) * kTwoPi / 1440.0;
    out.element_number = (t2.size() > 8) ? std::atoi(t2[8].c_str()) : 0;
    return true;
}

// ---------------------------------------------------------------------------
// Initialisation
// ---------------------------------------------------------------------------

bool sgp4_init(Sgp4& s, const Tle& t) {
    s.tumin = 1.0 / s.xke;
    s.vkmpersec = s.radiusearthkm * s.xke / 60.0;
    s.j3oj2 = s.j3 / s.j2;

    s.bstar = t.bstar;
    s.ndot = t.ndot;
    s.nddot = t.nddot;
    s.ecco = t.ecco;
    s.argpo = t.argpo;
    s.inclo = t.inclo;
    s.mo = t.mo;
    s.no_kozai = t.no_kozai;
    s.nodeo = t.nodeo;
    s.epoch = t.jdsatepoch;
    s.t = 0.0;
    s.atime = 0.0;

    // --- un-Kozai the mean motion and get the epoch auxiliary quantities ---
    const double x2o3 = 2.0 / 3.0;
    s.eccsq = s.ecco * s.ecco;
    s.omeosq = 1.0 - s.eccsq;
    s.rteosq = std::sqrt(s.omeosq);
    s.cosio = std::cos(s.inclo);
    s.cosio2 = s.cosio * s.cosio;

    const double ak = std::pow(s.xke / s.no_kozai, x2o3);
    double d1 = 0.75 * s.j2 * (3.0 * s.cosio2 - 1.0) / (s.rteosq * s.omeosq);
    double del = d1 / (ak * ak);
    const double adel = ak * (1.0 - del * del - del * (1.0 / 3.0 + 134.0 * del * del / 81.0));
    del = d1 / (adel * adel);
    s.no_unkozai = s.no_kozai / (1.0 + del);

    s.ao = std::pow(s.xke / s.no_unkozai, x2o3);
    s.sinio = std::sin(s.inclo);
    const double po = s.ao * s.omeosq;
    s.con42 = 1.0 - 5.0 * s.cosio2;
    s.con41 = -s.con42 - s.cosio2 - s.cosio2;
    s.ainv = 1.0 / s.ao;
    s.posq = po * po;
    s.rp = s.ao * (1.0 - s.ecco);
    s.method = 'n';
    s.gsto = gmst_from_jd_ut1(s.epoch + 2433281.5);

    if ((s.omeosq >= 0.0) || (s.no_unkozai >= 0.0)) {
        s.isimp = (s.rp < (220.0 / s.radiusearthkm + 1.0));

        const double ss = 78.0 / s.radiusearthkm + 1.0;
        const double qzms2ttemp = (120.0 - 78.0) / s.radiusearthkm;
        const double qzms2t = qzms2ttemp * qzms2ttemp * qzms2ttemp * qzms2ttemp;

        double sfour = ss;
        double qzms24 = qzms2t;
        const double perige = (s.rp - 1.0) * s.radiusearthkm;
        if (perige < 156.0) {
            sfour = perige - 78.0;
            if (perige < 98.0) sfour = 20.0;
            const double qzms24temp = (120.0 - sfour) / s.radiusearthkm;
            qzms24 = qzms24temp * qzms24temp * qzms24temp * qzms24temp;
            sfour = sfour / s.radiusearthkm + 1.0;
        }

        const double pinvsq = 1.0 / s.posq;
        const double tsi = 1.0 / (s.ao - sfour);
        s.eta = s.ao * s.ecco * tsi;
        const double etasq = s.eta * s.eta;
        const double eeta = s.ecco * s.eta;
        const double psisq = std::fabs(1.0 - etasq);
        const double coef = qzms24 * std::pow(tsi, 4.0);
        const double coef1 = coef / std::pow(psisq, 3.5);

        const double cc2 = coef1 * s.no_unkozai *
            (s.ao * (1.0 + 1.5 * etasq + eeta * (4.0 + etasq)) +
             0.375 * s.j2 * tsi / psisq * s.con41 * (8.0 + 3.0 * etasq * (8.0 + etasq)));
        s.cc1 = s.bstar * cc2;

        double cc3 = 0.0;
        if (s.ecco > 1.0e-4)
            cc3 = -2.0 * coef * tsi * s.j3oj2 * s.no_unkozai * s.sinio / s.ecco;

        s.x1mth2 = 1.0 - s.cosio2;
        s.cc4 = 2.0 * s.no_unkozai * coef1 * s.ao * s.omeosq *
            (s.eta * (2.0 + 0.5 * etasq) + s.ecco * (0.5 + 2.0 * etasq) -
             s.j2 * tsi / (s.ao * psisq) *
             (-3.0 * s.con41 * (1.0 - 2.0 * eeta + etasq * (1.5 - 0.5 * eeta)) +
              0.75 * s.x1mth2 * (2.0 * etasq - eeta * (1.0 + etasq)) * std::cos(2.0 * s.argpo)));
        s.cc5 = 2.0 * coef1 * s.ao * s.omeosq * (1.0 + 2.75 * (etasq + eeta) + eeta * etasq);

        const double cosio4 = s.cosio2 * s.cosio2;
        const double temp1 = 1.5 * s.j2 * pinvsq * s.no_unkozai;
        const double temp2 = 0.5 * temp1 * s.j2 * pinvsq;
        const double temp3 = -0.46875 * s.j4 * pinvsq * pinvsq * s.no_unkozai;

        s.mdot = s.no_unkozai + 0.5 * temp1 * s.rteosq * s.con41 +
                 0.0625 * temp2 * s.rteosq * (13.0 - 78.0 * s.cosio2 + 137.0 * cosio4);
        s.argpdot = -0.5 * temp1 * s.con42 +
                    0.0625 * temp2 * (7.0 - 114.0 * s.cosio2 + 395.0 * cosio4) +
                    temp3 * (3.0 - 36.0 * s.cosio2 + 49.0 * cosio4);
        const double xhdot1 = -temp1 * s.cosio;
        s.nodedot = xhdot1 + (0.5 * temp2 * (4.0 - 19.0 * s.cosio2) +
                    2.0 * temp3 * (3.0 - 7.0 * s.cosio2)) * s.cosio;
        const double xpidot = s.argpdot + s.nodedot;

        s.omgcof = s.bstar * cc3 * std::cos(s.argpo);
        s.xmcof = 0.0;
        if (s.ecco > 1.0e-4) s.xmcof = -x2o3 * coef * s.bstar / eeta;
        s.nodecf = 3.5 * s.omeosq * xhdot1 * s.cc1;
        s.t2cof = 1.5 * s.cc1;

        const double temp4 = 1.5e-12;
        if (std::fabs(s.cosio + 1.0) > 1.5e-12)
            s.xlcof = -0.25 * s.j3oj2 * s.sinio * (3.0 + 5.0 * s.cosio) / (1.0 + s.cosio);
        else
            s.xlcof = -0.25 * s.j3oj2 * s.sinio * (3.0 + 5.0 * s.cosio) / temp4;
        s.aycof = -0.5 * s.j3oj2 * s.sinio;

        const double delmotemp = 1.0 + s.eta * std::cos(s.mo);
        s.delmo = delmotemp * delmotemp * delmotemp;
        s.sinmao = std::sin(s.mo);
        s.x7thm1 = 7.0 * s.cosio2 - 1.0;

        // --- deep space ---
        if ((kTwoPi / s.no_unkozai) >= 225.0) {
            s.method = 'd';
            s.isimp = true;

            const double tc = 0.0;
            double inclm = s.inclo;
            const DsComOut c = dscom(s.epoch, s.ecco, s.argpo, tc, s.inclo, s.nodeo,
                                     s.no_unkozai);
            s.e3 = c.e3; s.ee2 = c.ee2;
            s.peo = c.peo; s.pgho = c.pgho; s.pho = c.pho;
            s.pinco = c.pinco; s.plo = c.plo;
            s.se2 = c.se2; s.se3 = c.se3;
            s.sgh2 = c.sgh2; s.sgh3 = c.sgh3; s.sgh4 = c.sgh4;
            s.sh2 = c.sh2; s.sh3 = c.sh3;
            s.si2 = c.si2; s.si3 = c.si3;
            s.sl2 = c.sl2; s.sl3 = c.sl3; s.sl4 = c.sl4;
            s.xgh2 = c.xgh2; s.xgh3 = c.xgh3; s.xgh4 = c.xgh4;
            s.xh2 = c.xh2; s.xh3 = c.xh3;
            s.xi2 = c.xi2; s.xi3 = c.xi3;
            s.xl2 = c.xl2; s.xl3 = c.xl3; s.xl4 = c.xl4;
            s.zmol = c.zmol; s.zmos = c.zmos;

            double ep = s.ecco, inclp = s.inclo, nodep = s.nodeo;
            double argpp = s.argpo, mp = s.mo;
            dpper(s, 0.0, true, ep, inclp, nodep, argpp, mp);

            double em = c.em, argpm = 0.0, mm = 0.0, nm = c.nm, nodem = 0.0;
            dsinit(s, c, tc, xpidot, em, argpm, inclm, mm, nm, nodem);
        }

        if (!s.isimp) {
            const double cc1sq = s.cc1 * s.cc1;
            s.d2 = 4.0 * s.ao * tsi * cc1sq;
            const double temp = s.d2 * tsi * s.cc1 / 3.0;
            s.d3 = (17.0 * s.ao + sfour) * temp;
            s.d4 = 0.5 * temp * s.ao * tsi * (221.0 * s.ao + 31.0 * sfour) * s.cc1;
            s.t3cof = s.d2 + 2.0 * cc1sq;
            s.t4cof = 0.25 * (3.0 * s.d3 + s.cc1 * (12.0 * s.d2 + 10.0 * cc1sq));
            s.t5cof = 0.2 * (3.0 * s.d4 + 12.0 * s.cc1 * s.d3 + 6.0 * s.d2 * s.d2 +
                             15.0 * cc1sq * (2.0 * s.d2 + cc1sq));
        }
    }

    // Propagate to zero epoch so every derived quantity is populated.
    Vec3 r{}, v{};
    Sgp4Error err = Sgp4Error::kOk;
    s.initialised = true;
    sgp4_propagate(s, 0.0, r, v, &err);
    return true;
}

// ---------------------------------------------------------------------------
// Propagation
// ---------------------------------------------------------------------------

bool sgp4_propagate(Sgp4& s, double tsince, Vec3& r_km, Vec3& v_km_s, Sgp4Error* error) {
    const double x2o3 = 2.0 / 3.0;
    s.t = tsince;

    // --- secular gravity and atmospheric drag ---
    double xmdf = s.mo + s.mdot * s.t;
    double argpdf = s.argpo + s.argpdot * s.t;
    double nodedf = s.nodeo + s.nodedot * s.t;
    double argpm = argpdf;
    double mm = xmdf;
    const double t2 = s.t * s.t;
    double nodem = nodedf + s.nodecf * t2;
    double tempa = 1.0 - s.cc1 * s.t;
    double tempe = s.bstar * s.cc4 * s.t;
    double templ = s.t2cof * t2;

    if (!s.isimp) {
        const double delomg = s.omgcof * s.t;
        const double delmtemp = 1.0 + s.eta * std::cos(xmdf);
        const double delm = s.xmcof * (delmtemp * delmtemp * delmtemp - s.delmo);
        const double temp = delomg + delm;
        mm = xmdf + temp;
        argpm = argpdf - temp;
        const double t3 = t2 * s.t;
        const double t4 = t3 * s.t;
        tempa = tempa - s.d2 * t2 - s.d3 * t3 - s.d4 * t4;
        tempe = tempe + s.bstar * s.cc5 * (std::sin(mm) - s.sinmao);
        templ = templ + s.t3cof * t3 + t4 * (s.t4cof + s.t * s.t5cof);
    }

    double nm = s.no_unkozai;
    double em = s.ecco;
    double inclm = s.inclo;

    if (s.method == 'd') {
        const double tc = s.t;
        double dndt = 0.0;
        dspace(s, tc, em, argpm, inclm, mm, nodem, dndt, nm);
    }

    if (nm <= 0.0) {
        if (error) *error = Sgp4Error::kMeanMotionNonPositive;
        return false;
    }

    double am = std::pow(s.xke / nm, x2o3) * tempa * tempa;
    nm = s.xke / std::pow(am, 1.5);
    em = em - tempe;

    if ((em >= 1.0) || (em < -0.001)) {
        if (error) *error = Sgp4Error::kEccentricityOutOfRange;
        return false;
    }
    if (em < 1.0e-6) em = 1.0e-6;

    mm = mm + s.no_unkozai * templ;
    double xlm = mm + argpm + nodem;

    nodem = std::fmod(nodem, kTwoPi);
    argpm = std::fmod(argpm, kTwoPi);
    xlm = std::fmod(xlm, kTwoPi);
    mm = std::fmod(xlm - argpm - nodem, kTwoPi);

    double sinim = std::sin(inclm);
    double cosim = std::cos(inclm);

    // --- lunar-solar periodics ---
    double ep = em;
    double xincp = inclm;
    double argpp = argpm;
    double nodep = nodem;
    double mp = mm;
    double sinip = sinim;
    double cosip = cosim;

    if (s.method == 'd') {
        dpper(s, s.t, false, ep, xincp, nodep, argpp, mp);
        if (xincp < 0.0) {
            xincp = -xincp;
            nodep = nodep + kPi;
            argpp = argpp - kPi;
        }
        if ((ep < 0.0) || (ep > 1.0)) {
            if (error) *error = Sgp4Error::kPerturbedEccentricity;
            return false;
        }
    }

    if (s.method == 'd') {
        sinip = std::sin(xincp);
        cosip = std::cos(xincp);
        s.aycof = -0.5 * s.j3oj2 * sinip;
        const double temp4 = 1.5e-12;
        if (std::fabs(cosip + 1.0) > 1.5e-12)
            s.xlcof = -0.25 * s.j3oj2 * sinip * (3.0 + 5.0 * cosip) / (1.0 + cosip);
        else
            s.xlcof = -0.25 * s.j3oj2 * sinip * (3.0 + 5.0 * cosip) / temp4;
    }

    const double axnl = ep * std::cos(argpp);
    const double temp = 1.0 / (am * (1.0 - ep * ep));
    const double aynl = ep * std::sin(argpp) + temp * s.aycof;
    const double xl = mp + argpp + nodep + temp * s.xlcof * axnl;

    // --- Kepler's equation ---
    const double u = std::fmod(xl - nodep, kTwoPi);
    double eo1 = u;
    double tem5 = 9999.9;
    int ktr = 1;
    while ((std::fabs(tem5) >= 1.0e-12) && (ktr <= 10)) {
        const double sineo1 = std::sin(eo1);
        const double coseo1 = std::cos(eo1);
        tem5 = 1.0 - coseo1 * axnl - sineo1 * aynl;
        tem5 = (u - aynl * coseo1 + axnl * sineo1 - eo1) / tem5;
        if (std::fabs(tem5) >= 0.95) tem5 = (tem5 > 0.0) ? 0.95 : -0.95;
        eo1 = eo1 + tem5;
        ktr = ktr + 1;
    }

    const double sineo1 = std::sin(eo1);
    const double coseo1 = std::cos(eo1);
    const double ecose = axnl * coseo1 + aynl * sineo1;
    const double esine = axnl * sineo1 - aynl * coseo1;
    const double el2 = axnl * axnl + aynl * aynl;
    const double pl = am * (1.0 - el2);
    if (pl < 0.0) {
        if (error) *error = Sgp4Error::kSemiLatusRectumNegative;
        return false;
    }

    const double rl = am * (1.0 - ecose);
    const double rdotl = std::sqrt(am) * esine / rl;
    const double rvdotl = std::sqrt(pl) / rl;
    const double betal = std::sqrt(1.0 - el2);
    const double tempq = esine / (1.0 + betal);
    const double sinu = am / rl * (sineo1 - aynl - axnl * tempq);
    const double cosu = am / rl * (coseo1 - axnl + aynl * tempq);
    double su = std::atan2(sinu, cosu);
    const double sin2u = 2.0 * cosu * sinu;
    const double cos2u = 1.0 - 2.0 * sinu * sinu;
    const double tempt = 1.0 / pl;
    const double temp1 = 0.5 * s.j2 * tempt;
    const double temp2 = temp1 * tempt;

    if (s.method == 'd') {
        const double cosisq = cosip * cosip;
        s.con41 = 3.0 * cosisq - 1.0;
        s.x1mth2 = 1.0 - cosisq;
        s.x7thm1 = 7.0 * cosisq - 1.0;
    }

    const double mrt = rl * (1.0 - 1.5 * temp2 * betal * s.con41) +
                       0.5 * temp1 * s.x1mth2 * cos2u;
    su = su - 0.25 * temp2 * s.x7thm1 * sin2u;
    const double xnode = nodep + 1.5 * temp2 * cosip * sin2u;
    const double xinc = xincp + 1.5 * temp2 * cosip * sinip * cos2u;
    const double mvt = rdotl - nm * temp1 * s.x1mth2 * sin2u / s.xke;
    const double rvdot = rvdotl + nm * temp1 * (s.x1mth2 * cos2u + 1.5 * s.con41) / s.xke;

    const double sinsu = std::sin(su);
    const double cossu = std::cos(su);
    const double snod = std::sin(xnode);
    const double cnod = std::cos(xnode);
    const double sini = std::sin(xinc);
    const double cosi = std::cos(xinc);
    const double xmx = -snod * cosi;
    const double xmy = cnod * cosi;
    const Vec3 uvec(xmx * sinsu + cnod * cossu, xmy * sinsu + snod * cossu, sini * sinsu);
    const Vec3 vvec(xmx * cossu - cnod * sinsu, xmy * cossu - snod * sinsu, sini * cossu);

    r_km = uvec * (mrt * s.radiusearthkm);
    v_km_s = (uvec * mvt + vvec * rvdot) * s.vkmpersec;

    if (mrt < 1.0) {
        if (error) *error = Sgp4Error::kDecayed;
        return false;
    }
    if (error) *error = Sgp4Error::kOk;
    return true;
}

const char* sgp4_error_string(Sgp4Error e) {
    switch (e) {
        case Sgp4Error::kOk: return "ok";
        case Sgp4Error::kEccentricityOutOfRange: return "perturbed eccentricity out of range";
        case Sgp4Error::kMeanMotionNonPositive: return "mean motion is not positive";
        case Sgp4Error::kPerturbedEccentricity: return "long-period perturbed eccentricity invalid";
        case Sgp4Error::kSemiLatusRectumNegative: return "semi-latus rectum negative";
        case Sgp4Error::kDecayed: return "object has decayed below one Earth radius";
    }
    return "unknown";
}

}  // namespace starpivot
