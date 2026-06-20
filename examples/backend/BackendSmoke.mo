model BackendSmoke
  parameter Real p = 0.5;
  Real x(start = 1.0, fixed = true);
  Real y;
  Real z;
equation
  der(x) = -p * x + sin(time);
  y = x + p;
  z = y * y;
end BackendSmoke;
